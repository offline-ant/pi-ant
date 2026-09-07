;;; pi-orchestration.el --- Native Pilish and EAT host operations -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Fixed, short operations invoked by emacsclient.  Pi owns worker scheduling
;; and completion; this library only owns native session/process targets.
;; Arguments and results are base64-encoded UTF-8 JSON, never executable Lisp.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'pilish)
(require 'eat)
(require 'server)

(defun pi-orchestration--session-environment (chat-buffer directory)
  "Return local host identity for CHAT-BUFFER in DIRECTORY before Pi spawns.
Remote sessions cannot use the shared local filesystem or Emacs server."
  (when (and (not (file-remote-p directory))
             (bound-and-true-p server-process)
             (process-live-p server-process))
    (list (cons "PI_ORCHESTRATION_HOST" "emacs")
          (cons "PI_ORCHESTRATION_ENDPOINT"
                (expand-file-name server-name server-socket-dir))
          (cons "PI_ORCHESTRATION_TARGET" (buffer-name chat-buffer)))))

(add-hook 'pilish-session-environment-functions
          #'pi-orchestration--session-environment)

(defun pi-orchestration-fork-here ()
  "Open an independent fork without touching this session's input draft."
  (interactive)
  (let ((chat (pilish-session-chat-buffer)))
    (unless (buffer-live-p chat)
      (user-error "No Pi session in this buffer"))
    (pilish-submit-prompt
     chat "/fork-here"
     (lambda (response)
       (unless (eq (plist-get response :success) t)
         (message "Pi: Fork failed: %s" (plist-get response :error)))))))

(define-key pilish-chat-mode-map (kbd "C-M-f") #'pi-orchestration-fork-here)
(define-key pilish-input-mode-map (kbd "C-M-f") #'pi-orchestration-fork-here)

(defvar pi-orchestration--targets (make-hash-table :test 'equal)
  "Native targets created by this adapter, indexed by opaque target ID.")

(defun pi-orchestration--environment (values)
  "Convert JSON object VALUES to an environment alist."
  (let (result)
    (while values
      (let ((key (pop values)) (value (pop values)))
        (push (cons (substring (symbol-name key) 1) value) result)))
    (nreverse result)))

(defun pi-orchestration--target (id)
  "Return owned target ID or signal a missing-target error."
  (or (gethash id pi-orchestration--targets)
      (error "Missing orchestration target: %s" id)))

(defun pi-orchestration--process (target)
  "Return the current native process for TARGET."
  (if (equal (plist-get target :kind) "pi")
      (pilish-session-process (plist-get target :buffer))
    (plist-get target :process)))

(defun pi-orchestration--state (id)
  "Return native liveness and startup readiness for target ID."
  (let* ((target (gethash id pi-orchestration--targets))
         (buffer (plist-get target :buffer))
         (process (and target (pi-orchestration--process target))))
    (list :state (cond ((not (buffer-live-p buffer)) "missing")
                       ((and process (process-live-p process)) "running")
                       (t "exited"))
          :ready (if (plist-get target :ready) t :json-false)
          :error (plist-get target :error))))

(defun pi-orchestration--start (data)
  "Create a native target described by DATA, returning immediately."
  (let* ((id (plist-get data :id))
         (spec (plist-get data :spec))
         (kind (plist-get spec :kind))
         (name (plist-get spec :name))
         (directory (file-name-as-directory (plist-get spec :cwd)))
         (endpoint (plist-get data :endpoint))
         (environment
          (append (list (cons "PI_ORCHESTRATION_HOST" "emacs")
                        (cons "PI_ORCHESTRATION_ENDPOINT" endpoint)
                        (cons "PI_ORCHESTRATION_TARGET" id))
                  (pi-orchestration--environment (plist-get spec :env))))
         (target (list :kind kind :responses (make-hash-table :test 'equal)
                       :ready nil :error nil :buffer nil :process nil)))
    (when (file-remote-p directory)
      (error "Orchestration requires a local directory and shared filesystem"))
    (when (gethash id pi-orchestration--targets)
      (error "Target already exists: %s" id))
    (puthash id target pi-orchestration--targets)
    (condition-case err
        (if (equal kind "pi")
            (let ((buffer
                   (pilish-start-session
                    directory name
                    :args (append (list "--session" (plist-get spec :sessionFile))
                                  (append (plist-get spec :args) nil))
                    :environment environment
                    :on-ready
                    (lambda (response)
                      (if (eq (plist-get response :success) t)
                          (setf (plist-get target :ready) t)
                        (setf (plist-get target :error)
                              (or (plist-get response :error) "Pi startup failed")))))))
              (setf (plist-get target :buffer) buffer))
          (unless (equal kind "shell") (error "Unknown target kind: %s" kind))
          (let ((default-directory directory)
                (process-environment (copy-sequence process-environment))
                (eat-kill-buffer-on-exit nil)
                (eat-query-before-killing-running-terminal nil))
            (dolist (entry (reverse environment))
              (setenv (car entry) (cdr entry)))
            (let ((buffer (eat-make (concat "pi-panel:" name ":" id)
                                    "/bin/sh" nil "-lc"
                                    (plist-get spec :command))))
              (setf (plist-get target :buffer) buffer
                    (plist-get target :process) (get-buffer-process buffer)
                    (plist-get target :ready) t))))
      (error
       (pi-orchestration--close id)
       (signal (car err) (cdr err))))
    (list :target (list :host "emacs" :endpoint endpoint :id id
                        :kind kind :name name
                        :sessionFile (plist-get spec :sessionFile)))))

(defun pi-orchestration--key-event (key)
  "Translate one neutral terminal KEY name to an EAT input event."
  (let* ((parts (split-string key "+"))
         (literal (car (last parts)))
         (base (downcase literal))
         (modifiers (mapcar
                     (lambda (modifier)
                       (pcase (downcase modifier)
                         ("ctrl" 'control) ("alt" 'meta) ("shift" 'shift)
                         (_ (error "Unsupported key modifier: %s" modifier))))
                     (butlast parts)))
         (event (cond
                 ((= (length base) 1) (aref literal 0))
                 ((equal base "enter") ?\r)
                 ((equal base "tab") ?\t)
                 ((equal base "space") ?\s)
                 ((equal base "escape") ?\e)
                 ((equal base "backspace") ?\x7f)
                 ((equal base "pageup") 'prior)
                 ((equal base "pagedown") 'next)
                 ((member base '("up" "down" "left" "right" "home" "end"
                                 "insert" "delete")) (intern base))
                 ((string-match-p "\\`f[1-9][0-9]?\\'" base) (intern base))
                 (t (error "Unsupported terminal key: %s" key)))))
    (event-convert-list (append modifiers (list event)))))

(defun pi-orchestration--send (data)
  "Submit typed input from DATA without reading or modifying a Pi draft."
  (let* ((target (pi-orchestration--target (plist-get data :id)))
         (buffer (plist-get target :buffer))
         (input (plist-get data :input))
         (kind (plist-get input :kind)))
    (unless (and (buffer-live-p buffer)
                 (process-live-p (pi-orchestration--process target)))
      (error "Target process is not running"))
    (if (equal (plist-get target :kind) "pi")
        (progn
          (unless (equal kind "prompt")
            (error "Pilish Pi targets accept prompts, not terminal text or keys"))
          (let* ((request (plist-get data :request))
                 (responses (plist-get target :responses)))
            (puthash request :pending responses)
            (condition-case err
                (pilish-submit-prompt
                 buffer (plist-get input :text)
                 (lambda (response) (puthash request response responses)))
              (error
               (remhash request responses)
               (signal (car err) (cdr err))))
            (list :pending t)))
      (with-current-buffer buffer
        (pcase kind
          ("text"
           (eat-term-send-string eat-terminal (plist-get input :text))
           (when (eq (plist-get input :enter) t)
             (eat-term-input-event eat-terminal 1 ?\r)))
          ("keys"
           (let ((events (mapcar #'pi-orchestration--key-event
                                 (append (plist-get input :keys) nil))))
             (dolist (event events)
               (eat-term-input-event eat-terminal 1 event))))
          (_ (error "Shell targets accept only terminal text or keys"))))
      (list :success t))))

(defun pi-orchestration--response (data)
  "Return an asynchronous prompt receipt identified by DATA."
  (let* ((target (pi-orchestration--target (plist-get data :id)))
         (responses (plist-get target :responses))
         (request (plist-get data :request))
         (response (gethash request responses)))
    (cond
     ((eq response :pending) (list :pending t))
     (response
      (remhash request responses)
      (list :success (plist-get response :success)
            :error (plist-get response :error)))
     (t (error "Missing prompt receipt: %s" request)))))

(defun pi-orchestration--read (data)
  "Read a bounded rendered snapshot for the target in DATA."
  (let* ((target (pi-orchestration--target (plist-get data :id)))
         (buffer (plist-get target :buffer))
         (lines (min 2000 (max 1 (or (plist-get data :lines) 80)))))
    (unless (buffer-live-p buffer) (error "Target buffer is missing"))
    (with-current-buffer buffer
      (save-excursion
        (save-restriction
          (widen)
          (goto-char (point-max))
          (forward-line (- lines))
          (list :output (buffer-substring-no-properties
                         (max (point) (- (point-max) 51200)) (point-max))))))))

(defun pi-orchestration--close (id &optional force)
  "Stop target ID and close only its owned buffers.
Let Pi handle SIGTERM first so it can kill detached tool processes.  Return
:pending while it exits; the caller polls without blocking Emacs.  FORCE
finishes cleanup when graceful shutdown exceeds the caller's deadline."
  (let* ((target (gethash id pi-orchestration--targets))
         (process (and target (pi-orchestration--process target)))
         (pi-target (equal (plist-get target :kind) "pi")))
    (if (and pi-target (process-live-p process) (not force))
        (progn
          (unless (plist-get target :closing)
            (signal-process process 'SIGTERM)
            (setf (plist-get target :closing) t))
          (list :pending t))
      (when target
        (when (and process (process-live-p process))
          (ignore-errors (signal-process (- (process-id process)) 'SIGKILL))
          (delete-process process))
        (let ((buffer (plist-get target :buffer)))
          (if pi-target
              (pilish-close-session buffer)
            (when (buffer-live-p buffer) (kill-buffer buffer))))
        (remhash id pi-orchestration--targets))
      (list :success t))))

(defun pi-orchestration-dispatch (encoded)
  "Execute one fixed operation from base64 JSON ENCODED and encode its result."
  (let ((result
         (condition-case err
             (let* ((data (json-parse-string
                           (decode-coding-string (base64-decode-string encoded) 'utf-8)
                           :object-type 'plist))
                    (id (plist-get data :id)))
               (pcase (plist-get data :operation)
                 ("start" (pi-orchestration--start data))
                 ("send" (pi-orchestration--send data))
                 ("response" (pi-orchestration--response data))
                 ("read" (pi-orchestration--read data))
                 ("state" (pi-orchestration--state id))
                 ("close" (pi-orchestration--close id (eq (plist-get data :force) t)))
                 (_ (error "Unknown orchestration operation"))))
           (error (list :error (error-message-string err))))))
    (base64-encode-string (encode-coding-string (json-encode result) 'utf-8) t)))

(provide 'pi-orchestration)
;;; pi-orchestration.el ends here
