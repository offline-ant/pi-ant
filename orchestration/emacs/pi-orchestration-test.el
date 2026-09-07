;;; pi-orchestration-test.el --- Native host contracts -*- lexical-binding: t; -*-

(require 'pi-orchestration)
(require 'pilish-test-common)

(ert-deftest pi-orchestration-native-shell-keys-output-exit-and-close ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (id "eat-native-test")
         (window (selected-window)) (before (window-buffer))
         (response (pi-orchestration--start
                    (list :id id :endpoint "test"
                          :spec '(:kind "shell" :name "eat-test" :cwd "/tmp/"
                                        :command "stty -echo; printf 'READY\\n'; read line; printf 'RECEIVED:%s\\n' \"$line\"")))))
    (unwind-protect
        (progn
          (should (equal (plist-get (plist-get response :target) :id) id))
          (should (eq (selected-window) window))
          (should (eq (window-buffer) before))
          (should (pilish-test-wait-until
                   (lambda () (string-match-p "READY" (plist-get (pi-orchestration--read (list :id id)) :output))) 5))
          (pi-orchestration--send (list :id id :input '(:kind "text" :text "literal ctrl+c 'quoted'" :enter :false)))
          (pi-orchestration--send (list :id id :input '(:kind "keys" :keys ["Enter"])))
          (should (pilish-test-wait-until
                   (lambda () (equal (plist-get (pi-orchestration--state id) :state) "exited")) 5))
          (should (string-match-p (regexp-quote "RECEIVED:literal ctrl+c 'quoted'")
                                  (plist-get (pi-orchestration--read (list :id id)) :output)))
          (should-error (pi-orchestration--send (list :id id :input '(:kind "prompt" :text "bad")))))
      (pi-orchestration--close id))
    (should (equal (plist-get (pi-orchestration--state id) :state) "missing"))))

(ert-deftest pi-orchestration-terminal-key-encoding-through-eat ()
  (with-temp-buffer
    (let ((terminal (eat-term-make (current-buffer) (point-min))) output)
      (setf (eat-term-parameter terminal 'input-function)
            (lambda (_ text) (push text output)))
      (dolist (key '("ctrl+c" "Escape" "Up" "alt+x" "Tab" "F5" "A" "Alt+X"))
        (eat-term-input-event terminal 1 (pi-orchestration--key-event key)))
      (should (equal (apply #'concat (nreverse output)) "\3\e\e[A\ex\t\e[15~A\eX"))
      (should-error (pi-orchestration--key-event "not-a-key")))))

(ert-deftest pi-orchestration-pilish-start-receipt-draft-and-process-ownership ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (dir (pilish-test--make-temp-directory "pi-native-host-"))
         (session (expand-file-name "session.jsonl" dir))
         (pilish-executable (pilish-test-fake-pi-executable))
         (pilish-extra-args (pilish-test-fake-pi-extra-args "prompt-lifecycle"))
         (id "native-pilish-test")
         (spec (list :kind "pi" :name "native-test" :cwd dir :sessionFile session :args []))
         (start-session (symbol-function 'pilish-start-session))
         buffer process)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish--check-dependencies) #'ignore)
                  ;; The existing RPC double has no --session CLI flag. Check
                  ;; the launch contract, then use its fresh-session startup.
                  ((symbol-function 'pilish-start-session)
                   (lambda (directory name &rest options)
                     (should (equal (plist-get options :args) (list "--session" session)))
                     (funcall start-session directory name
                              :environment (plist-get options :environment)
                              :on-ready (plist-get options :on-ready)))))
          (pi-orchestration--start (list :id id :endpoint "test-server" :spec spec))
          (setq buffer (plist-get (pi-orchestration--target id) :buffer)
                process (pilish-session-process buffer))
          (should (pilish-test-wait-until
                   (lambda () (eq (plist-get (pi-orchestration--state id) :ready) t)) 5))
          (with-current-buffer (pilish-session-input-buffer buffer) (insert "human draft"))
          (pi-orchestration--send (list :id id :request "request-1"
                                        :input '(:kind "prompt" :text "hello")))
          (should (pilish-test-wait-until
                   (lambda ()
                     (not (eq (gethash "request-1" (plist-get (pi-orchestration--target id) :responses)) :pending))) 5))
          (should (eq (plist-get (pi-orchestration--response (list :id id :request "request-1")) :success) t))
          (should (equal (with-current-buffer (pilish-session-input-buffer buffer) (buffer-string)) "human draft"))
          (should-error (pi-orchestration--send (list :id id :input '(:kind "text" :text "wrong"))))
          (should (plist-get (pi-orchestration--close id) :pending))
          (should (pilish-test-wait-until
                   (lambda () (plist-get (pi-orchestration--close id) :success)) 5))
          (should-not (process-live-p process))
          (should-not (buffer-live-p buffer)))
      (pi-orchestration--close id t)
      (delete-directory dir t))))

(ert-deftest pi-orchestration-dispatch-treats-arguments-as-data ()
  (let* ((text "\" ) (error \"injected\") ;\n你好")
         (request (base64-encode-string (encode-coding-string (json-encode (list :operation text)) 'utf-8) t))
         (response (json-parse-string
                    (decode-coding-string (base64-decode-string (pi-orchestration-dispatch request)) 'utf-8)
                    :object-type 'plist)))
    (should (equal (plist-get response :error) "Unknown orchestration operation"))))

(ert-deftest pi-orchestration-eat-fullscreen-snapshot-and-owned-close ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (id "eat-fullscreen-test") process)
    (unwind-protect
        (progn
          (pi-orchestration--start
           (list :id id :endpoint "test"
                 :spec '(:kind "shell" :name "fullscreen" :cwd "/tmp/"
                               :command "printf '\\033[?1049hCURSES READY\\r\\n'; read line")))
          (setq process (pi-orchestration--process (pi-orchestration--target id)))
          (should (pilish-test-wait-until
                   (lambda () (string-match-p "CURSES READY"
                                               (plist-get (pi-orchestration--read (list :id id)) :output))) 5))
          (should (equal (plist-get (pi-orchestration--state id) :state) "running"))
          (pi-orchestration--close id)
          (should-not (process-live-p process)))
      (pi-orchestration--close id))))

(ert-deftest pi-orchestration-close-pi-allows-signal-cleanup-before-owned-buffer-close ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (buffer (generate-new-buffer " *pi-close-test*"))
         (process (make-pipe-process :name "pi-close-test" :noquery t))
         (other (make-pipe-process :name "pi-other-test" :noquery t))
         signals)
    (unwind-protect
        (progn
          (with-current-buffer buffer
            (pilish-chat-mode)
            (pilish--set-process process))
          (puthash "close-test" (list :kind "pi" :buffer buffer :closing nil)
                   pi-orchestration--targets)
          (cl-letf (((symbol-function 'signal-process)
                     (lambda (target signal) (push (list target signal) signals) 0)))
            (should (plist-get (pi-orchestration--close "close-test") :pending))
            (should (plist-get (pi-orchestration--close "close-test") :pending))
            (should (equal signals (list (list process 'SIGTERM))))
            (should (buffer-live-p buffer))
            (should (process-live-p process)))
          (delete-process process)
          (should (plist-get (pi-orchestration--close "close-test") :success))
          (should-not (buffer-live-p buffer))
          (should (process-live-p other)))
      (pi-orchestration--close "close-test" t)
      (when (buffer-live-p buffer) (kill-buffer buffer))
      (when (process-live-p process) (delete-process process))
      (delete-process other))))

(ert-deftest pi-orchestration-fork-shortcut-preserves-draft-while-busy ()
  (let ((dir (pilish-test--make-temp-directory "pi-fork-shortcut-")))
    (unwind-protect
        (pilish-test-with-mock-session dir
          (let* ((chat (get-buffer (pilish-test--chat-buffer-name dir)))
                 (input (pilish-session-input-buffer chat)) sent)
            (with-current-buffer chat (setq pilish--status 'streaming))
            (cl-letf (((symbol-function 'pilish-submit-prompt)
                       (lambda (buffer text callback &optional _behavior)
                         (should (eq buffer chat))
                         (push text sent)
                         (funcall callback '(:success t)))))
              (with-current-buffer input (insert "unsent draft"))
              (dolist (buffer (list chat input))
                (with-current-buffer buffer
                  (should (eq (key-binding (kbd "C-M-f")) #'pi-orchestration-fork-here))
                  (call-interactively (key-binding (kbd "C-M-f")))))
              (should (equal sent '("/fork-here" "/fork-here")))
              (should (equal (with-current-buffer input (buffer-string)) "unsent draft")))))
      (delete-directory dir t))))

(ert-deftest pi-orchestration-root-session-marked-before-normal-interactive-spawn ()
  (let* ((dir (pilish-test--make-temp-directory "pi-root-host-"))
         (default-directory (file-name-as-directory dir))
         (pilish-executable (pilish-test-fake-pi-executable))
         (pilish-extra-args (pilish-test-fake-pi-extra-args "prompt-lifecycle"))
         (server-process (make-pipe-process :name "pi-test-server" :noquery t))
         (server-name "test-server") (server-socket-dir dir)
         (make-process (symbol-function 'make-process))
         launch chat)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish--check-dependencies) #'ignore)
                  ((symbol-function 'pilish--show-session-buffers) #'ignore)
                  ((symbol-function 'make-process)
                   (lambda (&rest options)
                     (when (equal (plist-get options :name) "pi")
                       (setq launch (mapcar #'getenv '("PI_ORCHESTRATION_HOST"
                                                      "PI_ORCHESTRATION_ENDPOINT"
                                                      "PI_ORCHESTRATION_TARGET"))))
                     (apply make-process options))))
          (should (memq #'pi-orchestration--session-environment
                        pilish-session-environment-functions))
          (pilish)
          (setq chat (get-buffer (pilish-test--chat-buffer-name dir)))
          (should (equal launch (list "emacs" (expand-file-name server-name dir)
                                       (buffer-name chat))))
          (should-not (pi-orchestration--session-environment chat "/ssh:remote:/tmp/"))
          (delete-process server-process)
          (should-not (pi-orchestration--session-environment chat dir)))
      (pilish-close-session chat)
      (when (process-live-p server-process) (delete-process server-process))
      (delete-directory dir t))))

(provide 'pi-orchestration-test)
;;; pi-orchestration-test.el ends here
