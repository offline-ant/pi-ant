;;; pi-orchestration.el --- Native Pilish and ghostel host operations -*- lexical-binding: t; -*-

;; SPDX-License-Identifier: MIT

;;; Commentary:

;; Fixed, short operations invoked by emacsclient.  Pi owns worker scheduling
;; and completion; this library only owns native session/process targets.
;; Arguments and results are base64-encoded UTF-8 JSON, never executable Lisp.

;;; Code:

(require 'cl-lib)
(require 'json)
(require 'pilish)
(require 'ghostel)
(require 'server)

;; Ghostel exposes no public accessors for these; they are the terminal's own
;; child process ID and its full plain-text contents (scrollback and the
;; active screen), which are also current for buffers never displayed.
(defvar ghostel--pid)
(defvar ghostel--term)
(declare-function ghostel--copy-all-text "ghostel-module" (term))

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

(defvar pi-orchestration-target-functions nil
  "Functions called with a target ID and `start' or `close' after either.
User interfaces use this to refresh their view of `pi-orchestration-targets'.")

(defun pi-orchestration--run-target-functions (id event)
  "Report target ID's lifecycle EVENT without letting observers break it."
  (dolist (function pi-orchestration-target-functions)
    (with-demoted-errors "pi-orchestration observer: %S"
      (funcall function id event))))

(defun pi-orchestration-parent-buffer (parent)
  "Return the live native buffer of PARENT, a target ID or root chat name.
Workers name their parent by target ID; root sessions by chat buffer name."
  (when parent
    (let ((target (gethash parent pi-orchestration--targets)))
      (if target
          (plist-get target :buffer)
        (get-buffer parent)))))

(defun pi-orchestration-targets ()
  "Return native targets as plists.
Keys: :id, :kind, :name, :placement, :buffer and :parent.
:placement is the start spec's placement (\"worker\" or \"interactive-fork\"),
:parent the parent's live native buffer, or nil when unknown or gone."
  (let (targets)
    (maphash (lambda (id target)
               (push (list :id id :kind (plist-get target :kind)
                           :name (plist-get target :name)
                           :placement (plist-get target :placement)
                           :buffer (plist-get target :buffer)
                           :parent (pi-orchestration-parent-buffer
                                    (plist-get target :parent)))
                     targets))
             pi-orchestration--targets)
    targets))

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
         (target (list :kind kind :name name
                       :placement (plist-get spec :placement)
                       :parent (plist-get (plist-get spec :parent) :id)
                       :responses (make-hash-table :test 'equal)
                       :ready nil :error nil :buffer nil :process nil :pid nil)))
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
                (argv (append (plist-get spec :argv) nil))
                (buffer (generate-new-buffer (concat "pi-panel:" name ":" id))))
            (dolist (entry (reverse environment))
              (setenv (car entry) (cdr entry)))
            (setf (plist-get target :buffer) buffer)
            (with-current-buffer buffer (setq default-directory directory))
            (let ((process (ghostel-exec buffer (car argv) (cdr argv))))
              (with-current-buffer buffer
                ;; Exited panels stay readable until closed, and closing
                ;; never asks about a running command.
                (setq-local ghostel-kill-buffer-on-exit nil
                            ghostel-query-before-killing nil)
                (setf (plist-get target :process) process
                      (plist-get target :pid) ghostel--pid
                      (plist-get target :ready) t)))))
      (error
       (pi-orchestration--close id)
       (signal (car err) (cdr err))))
    (pi-orchestration--run-target-functions id 'start)
    (list :target (list :host "emacs" :endpoint endpoint :id id
                        :kind kind :name name
                        :sessionFile (plist-get spec :sessionFile)))))

(defun pi-orchestration--key (key)
  "Translate one neutral terminal KEY name to ghostel (NAME MODIFIERS).
NAME is a key for `ghostel-send-key'; MODIFIERS a comma-separated string."
  (let* ((parts (split-string key "+"))
         (literal (car (last parts)))
         (base (downcase literal))
         (modifiers (mapcar
                     (lambda (modifier)
                       (pcase (downcase modifier)
                         ("ctrl" "ctrl") ("alt" "alt") ("shift" "shift")
                         (_ (error "Unsupported key modifier: %s" modifier))))
                     (butlast parts)))
         (name (cond
                ((= (length base) 1) literal)
                ((equal base "enter") "return")
                ((equal base "pageup") "prior")
                ((equal base "pagedown") "next")
                ((member base '("tab" "space" "escape" "backspace"
                                "up" "down" "left" "right" "home" "end"
                                "insert" "delete"))
                 base)
                ((string-match-p "\\`f[1-9][0-9]?\\'" base) base)
                (t (error "Unsupported terminal key: %s" key)))))
    (list name (string-join modifiers ","))))

(defun pi-orchestration--send-key (name modifiers)
  "Send key NAME with MODIFIERS to the current ghostel terminal.
Printable characters without Ctrl or Alt are typed as text, so their case
is exact; everything else goes through the terminal's key encoder."
  (if (and (= (length name) 1)
           (not (string-match-p "ctrl\\|alt" modifiers)))
      (ghostel-send-string (if (string-search "shift" modifiers) (upcase name) name))
    (ghostel-send-key name modifiers)))

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
           (ghostel-send-string
            (encode-coding-string (plist-get input :text) 'utf-8))
           (when (eq (plist-get input :enter) t)
             (ghostel-send-key "return")))
          ("keys"
           (let ((keys (mapcar #'pi-orchestration--key
                               (append (plist-get input :keys) nil))))
             (dolist (key keys)
               (apply #'pi-orchestration--send-key key))))
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

(defun pi-orchestration--tail (lines)
  "Return the last LINES lines of the current buffer, at most 50 KiB."
  (save-excursion
    (save-restriction
      (widen)
      (goto-char (point-max))
      (forward-line (- lines))
      (buffer-substring-no-properties
       (max (point) (- (point-max) 51200)) (point-max)))))

(defun pi-orchestration--read (data)
  "Read a bounded rendered snapshot for the target in DATA.
Ghostel renders a terminal into its buffer only while displayed, so
terminal text comes from the terminal itself, including hidden panels."
  (let* ((target (pi-orchestration--target (plist-get data :id)))
         (buffer (plist-get target :buffer))
         (lines (min 2000 (max 1 (or (plist-get data :lines) 80)))))
    (unless (buffer-live-p buffer) (error "Target buffer is missing"))
    (list :output
          (with-current-buffer buffer
            (if (and (derived-mode-p 'ghostel-mode) ghostel--term)
                (let ((text (or (ghostel--copy-all-text ghostel--term) "")))
                  (with-temp-buffer
                    (insert (string-trim-right text))
                    (pi-orchestration--tail lines)))
              (pi-orchestration--tail lines))))))

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
          (let ((pid (if pi-target (process-id process) (plist-get target :pid))))
            (when pid (ignore-errors (signal-process (- pid) 'SIGKILL))))
          (delete-process process))
        (let ((buffer (plist-get target :buffer)))
          (if pi-target
              (pilish-close-session buffer)
            (when (buffer-live-p buffer) (kill-buffer buffer))))
        (remhash id pi-orchestration--targets)
        (pi-orchestration--run-target-functions id 'close))
      (list :success t))))


;;;###autoload
(defun pi-orchestration-stop-target (id)
  "Stop target ID on the user's behalf and close its buffers.
A shell target is killed at once.  A Pi target gets SIGTERM, so it can stop
its own tool processes, and is killed if it still runs after five seconds.
Pi notices the missing target at its next read."
  (when (eq (plist-get (pi-orchestration--close id) :pending) t)
    (let ((deadline (+ (float-time) 5))
          (timer nil))
      (setq timer
            (run-with-timer
             0.2 0.2
             (lambda ()
               (unless (eq (plist-get (pi-orchestration--close id (> (float-time) deadline))
                                      :pending)
                           t)
                 (cancel-timer timer))))))))


;;;; Ordinary sessions opened by `/switch emacs'

(defvar pi-orchestration-show-session-function #'pi-orchestration-show-session
  "Function called with the chat buffer of a session opened by `/switch emacs'.
It shows the session; pi-deck replaces it to use the space for the
session's directory.")

(defvar pi-orchestration--switches (make-hash-table :test 'equal)
  "`/switch emacs' openings by request ID: plists with :buffer, :ready, :failure.")

(defun pi-orchestration--client-frame ()
  "Return the most recently used client frame, or nil when none exists."
  (let (best best-time)
    (dolist (frame (frame-list))
      (unless (or (equal (terminal-name (frame-terminal frame)) "initial_terminal")
                  (frame-parent frame))
        (let ((time (window-use-time (get-mru-window frame t))))
          (when (or (null best) (> time best-time))
            (setq best frame best-time time)))))
    best))

(defun pi-orchestration-show-session (chat)
  "Show CHAT with its input in the most recently used client frame.
Without a client frame the session stays open in the background."
  (when-let* ((frame (pi-orchestration--client-frame)))
    (select-frame-set-input-focus frame)
    (pop-to-buffer chat)
    (let ((input (pilish-session-input-buffer chat)))
      (unless (get-buffer-window input frame)
        (pilish-split-input-window (get-buffer-window chat frame) input))
      (when-let* ((window (get-buffer-window input frame)))
        (select-window window)))))

(defun pi-orchestration--canonical-file (file)
  "Return FILE's true name, or its absolute name when it does not exist."
  (if (file-exists-p file) (file-truename file) (expand-file-name file)))

(defun pi-orchestration--session-view (file)
  "Return a live Pilish chat buffer that has session FILE open, or nil."
  (let ((file (pi-orchestration--canonical-file file)))
    (cl-find-if (lambda (buffer)
                  (and (eq (buffer-local-value 'major-mode buffer) 'pilish-chat-mode)
                       (when-let* ((open (plist-get (buffer-local-value 'pilish--state buffer)
                                                    :session-file)))
                         (and (not (file-remote-p open))
                              (equal (pi-orchestration--canonical-file open) file)))))
                (buffer-list))))

(defun pi-orchestration--free-session-name (directory)
  "Return nil when DIRECTORY's default session is free, else a free number."
  (let ((name nil) (n 1))
    (while (or (pilish--find-session directory name)
               (get-buffer (pilish--buffer-name :chat directory name))
               (get-buffer (pilish--buffer-name :input directory name)))
      (setq name (number-to-string (cl-incf n))))
    name))

(defun pi-orchestration--switch (data)
  "Open the session file in DATA as an ordinary root session and show it.
An idle Pilish view that already has the file open reloads it instead.
Readiness is reported later by `pi-orchestration--switch-state'."
  (let* ((id (plist-get data :id))
         (file (pi-orchestration--canonical-file (plist-get data :sessionFile)))
         (directory (file-name-as-directory (plist-get data :cwd)))
         (record (list :buffer nil :ready nil :failure nil :refreshed nil))
         (settle (lambda (failure)
                   (if failure
                       (setf (plist-get record :failure) failure)
                     (setf (plist-get record :ready) t))))
         (existing (pi-orchestration--session-view file)))
    (when (file-remote-p directory)
      (error "/switch emacs requires a local directory"))
    (when (gethash id pi-orchestration--switches)
      (error "Switch already exists: %s" id))
    (if existing
        (with-current-buffer existing
          (when (or (not (eq pilish--status 'idle))
                    pilish--followup-queue
                    (pilish-session-pending-dialogs existing))
            (error "The Emacs view of this session is busy or has queued input; finish it first"))
          (setf (plist-get record :buffer) existing (plist-get record :refreshed) t)
          (puthash id record pi-orchestration--switches)
          (pilish-reload settle))
      ;; The session environment hook supplies this Emacs host's identity.
      (let ((buffer (pilish-start-session
                     directory (pi-orchestration--free-session-name directory)
                     :args (cons "--session" (cons file (append (plist-get data :args) nil)))
                     :environment (pi-orchestration--environment (plist-get data :env))
                     :on-ready
                     (lambda (response)
                       (let ((opened (plist-get (plist-get response :data) :sessionFile)))
                         (funcall settle
                                  (cond
                                   ((not (eq (plist-get response :success) t))
                                    (or (plist-get response :error) "Pi startup failed"))
                                   ((not (and (stringp opened)
                                              (equal (pi-orchestration--canonical-file opened) file)))
                                    "Pi opened a different session file"))))))))
        (setf (plist-get record :buffer) buffer)
        (puthash id record pi-orchestration--switches)))
    (with-demoted-errors "pi-orchestration show session: %S"
      (funcall pi-orchestration-show-session-function (plist-get record :buffer)))
    (list :buffer (buffer-name (plist-get record :buffer))
          :refreshed (if (plist-get record :refreshed) t :json-false))))

(defun pi-orchestration--switch-state (data)
  "Report the `/switch emacs' opening in DATA; settled records are forgotten.
With :close, stop a newly started session after a failed opening."
  (let* ((id (plist-get data :id))
         (record (or (gethash id pi-orchestration--switches)
                     (error "Missing switch: %s" id)))
         (buffer (plist-get record :buffer))
         (process (pilish-session-process buffer))
         (state (cond ((not (buffer-live-p buffer)) "missing")
                      ((and process (process-live-p process)) "running")
                      (t "exited"))))
    (when (or (plist-get record :ready) (plist-get record :failure)
              (eq (plist-get data :close) t))
      (remhash id pi-orchestration--switches))
    (when (and (eq (plist-get data :close) t) (not (plist-get record :refreshed)))
      (pilish-close-session buffer))
    (list :state state
          :ready (if (plist-get record :ready) t :json-false)
          ;; Not :error, which reports a failed operation.
          :failure (plist-get record :failure))))

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
                 ("switch" (pi-orchestration--switch data))
                 ("switch-state" (pi-orchestration--switch-state data))
                 (_ (error "Unknown orchestration operation"))))
           (error (list :error (error-message-string err))))))
    (base64-encode-string (encode-coding-string (json-encode result) 'utf-8) t)))

(provide 'pi-orchestration)
;;; pi-orchestration.el ends here
