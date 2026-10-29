;;; pi-orchestration-test.el --- Native host contracts -*- lexical-binding: t; -*-

(require 'pi-orchestration)
(require 'pilish-test-common)

(ert-deftest pi-orchestration-native-shell-keys-output-exit-and-close ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (id "ghostel-native-test")
         (window (selected-window)) (before (window-buffer))
         (response (pi-orchestration--start
                    (list :id id :endpoint "test"
                          :spec '(:kind "shell" :name "ghostel-test" :cwd "/tmp/"
                                        :argv ["/bin/bash" "-c" "stty -echo; false | true; printf 'READY:%s\\n' \"${PIPESTATUS[0]}\"; read line; printf 'RECEIVED:%s\\n' \"$line\""])))))
    (unwind-protect
        (progn
          (should (equal (plist-get (plist-get response :target) :id) id))
          (should (eq (selected-window) window))
          (should (eq (window-buffer) before))
          (should (pilish-test-wait-until
                   (lambda () (string-match-p "READY:1" (plist-get (pi-orchestration--read (list :id id)) :output))) 5))
          (pi-orchestration--send (list :id id :input '(:kind "text" :text "literal ctrl+c 'quoted'" :enter :false)))
          (pi-orchestration--send (list :id id :input '(:kind "keys" :keys ["Enter"])))
          (should (pilish-test-wait-until
                   (lambda () (equal (plist-get (pi-orchestration--state id) :state) "exited")) 5))
          (should (string-match-p (regexp-quote "RECEIVED:literal ctrl+c 'quoted'")
                                  (plist-get (pi-orchestration--read (list :id id)) :output)))
          (should-error (pi-orchestration--send (list :id id :input '(:kind "prompt" :text "bad")))))
      (pi-orchestration--close id))
    (should (equal (plist-get (pi-orchestration--state id) :state) "missing"))))

(ert-deftest pi-orchestration-terminal-keys-reach-the-program-as-bytes ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (id "ghostel-keys-test")
         (keys ["ctrl+c" "Escape" "Up" "alt+x" "Tab" "F5" "A" "Alt+X" "shift+b" "PageDown" "Enter"])
         (expected "\3\e\e[A\ex\t\e[15~A\eXB\e[6~\r"))
    (pi-orchestration--start
     (list :id id :endpoint "test"
           :spec (list :kind "shell" :name "keys" :cwd "/tmp/"
                       :argv (vector "/bin/sh" "-c"
                                     (format "stty raw -echo; printf 'READY\\n'; dd bs=1 count=%d 2>/dev/null | od -An -tx1 | tr -d ' \\n'; printf '\\nEND\\n'; read line"
                                             (length expected))))))
    (unwind-protect
        (progn
          (should (pilish-test-wait-until
                   (lambda () (string-match-p "READY" (plist-get (pi-orchestration--read (list :id id)) :output))) 5))
          (pi-orchestration--send (list :id id :input (list :kind "keys" :keys keys)))
          (should (pilish-test-wait-until
                   (lambda () (string-match-p "END" (plist-get (pi-orchestration--read (list :id id)) :output))) 5))
          (should (string-match-p
                   (regexp-quote (mapconcat (lambda (byte) (format "%02x" byte)) expected ""))
                   (plist-get (pi-orchestration--read (list :id id)) :output)))
          (should-error (pi-orchestration--key "not-a-key"))
          (should-error (pi-orchestration--key "hyper+x")))
      (pi-orchestration--close id))))

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
                     (should (equal (plist-get options :session-file) session))
                     (should-not (plist-get options :args))
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

(ert-deftest pi-orchestration-targets-report-parents-and-lifecycle ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (root (generate-new-buffer "*pilish-chat:/tmp/root*"))
         (events nil)
         (pi-orchestration-target-functions
          (list (lambda (id event) (push (list id event) events)))))
    (unwind-protect
        (progn
          (pi-orchestration--start
           (list :id "panel-a" :endpoint "test"
                 :spec (list :kind "shell" :name "a" :cwd "/tmp/" :placement "worker"
                             :parent (list :id (buffer-name root))
                             :argv ["/bin/sh" "-c" "read line"])))
          (pi-orchestration--start
           (list :id "panel-b" :endpoint "test"
                 :spec '(:kind "shell" :name "b" :cwd "/tmp/" :parent (:id "panel-a")
                               :argv ["/bin/sh" "-c" "read line"])))
          (should (equal (reverse events) '(("panel-a" start) ("panel-b" start))))
          (let ((targets (pi-orchestration-targets)))
            (should (eq (plist-get (cl-find "panel-a" targets :key (lambda (target) (plist-get target :id)) :test #'equal) :parent)
                        root))
            (should (eq (plist-get (cl-find "panel-b" targets :key (lambda (target) (plist-get target :id)) :test #'equal) :parent)
                        (plist-get (pi-orchestration--target "panel-a") :buffer)))
            (should (equal (plist-get (car targets) :kind) "shell"))
            (should (equal (plist-get (cl-find "panel-a" targets :key (lambda (target) (plist-get target :id)) :test #'equal) :placement)
                           "worker")))
          (pi-orchestration-stop-target "panel-b")
          (should (equal (car events) '("panel-b" close)))
          (should (= (length (pi-orchestration-targets)) 1)))
      (pi-orchestration--close "panel-a")
      (pi-orchestration--close "panel-b")
      (kill-buffer root))))

(ert-deftest pi-orchestration-dispatch-treats-arguments-as-data ()
  (let* ((text "\" ) (error \"injected\") ;\n你好")
         (request (base64-encode-string (encode-coding-string (json-encode (list :operation text)) 'utf-8) t))
         (response (json-parse-string
                    (decode-coding-string (base64-decode-string (pi-orchestration-dispatch request)) 'utf-8)
                    :object-type 'plist)))
    (should (equal (plist-get response :error) "Unknown orchestration operation"))))

(ert-deftest pi-orchestration-ghostel-fullscreen-snapshot-and-owned-close ()
  (let* ((pi-orchestration--targets (make-hash-table :test 'equal))
         (id "ghostel-fullscreen-test") process)
    (unwind-protect
        (progn
          (pi-orchestration--start
           (list :id id :endpoint "test"
                 :spec '(:kind "shell" :name "fullscreen" :cwd "/tmp/"
                               :argv ["/bin/sh" "-c" "printf '\\033[?1049hCURSES READY\\r\\n'; read line"])))
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

(ert-deftest pi-orchestration-switch-opens-root-session-and-reports-readiness ()
  (let* ((pi-orchestration--switches (make-hash-table :test 'equal))
         (dir (file-name-as-directory (pilish-test--make-temp-directory "pi-switch-open-")))
         (file (expand-file-name "session.jsonl" dir))
         (shown nil) (on-ready nil) (closed nil)
         (pi-orchestration-show-session-function (lambda (chat) (push chat shown)))
         (chat (generate-new-buffer "*pilish-chat:switch-test*")))
    (write-region "" nil file)
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-start-session)
                   (lambda (directory name &rest options)
                     (should (equal directory dir))
                     (should-not name)
                     (should (equal (plist-get options :session-file) (file-truename file)))
                     (should (equal (plist-get options :args) '("--model" "one")))
                     ;; Explicit environment never carries host identity;
                     ;; the session environment hook supplies it.
                     (should (equal (plist-get options :environment)
                                    '(("PI_CODING_AGENT_DIR" . "/agent"))))
                     (setq on-ready (plist-get options :on-ready))
                     chat))
                  ((symbol-function 'pilish-session-process) (lambda (_) nil))
                  ((symbol-function 'pilish-close-session) (lambda (buffer) (push buffer closed))))
          (let ((reply (pi-orchestration--switch
                        (list :id "s1" :sessionFile file :cwd dir :args ["--model" "one"]
                              :env '(:PI_CODING_AGENT_DIR "/agent")))))
            (should (equal (plist-get reply :buffer) (buffer-name chat)))
            (should (eq (plist-get reply :refreshed) :json-false)))
          (should (equal shown (list chat)))
          (should (eq (plist-get (pi-orchestration--switch-state '(:id "s1")) :ready) :json-false))
          (funcall on-ready (list :success t :data (list :sessionFile file)))
          (should (eq (plist-get (pi-orchestration--switch-state '(:id "s1")) :ready) t))
          (should-error (pi-orchestration--switch-state '(:id "s1")) :type 'error)
          ;; A different file is a failure, and failed openings close.
          (pi-orchestration--switch (list :id "s2" :sessionFile file :cwd dir :args ["--model" "one"]
                                          :env '(:PI_CODING_AGENT_DIR "/agent")))
          (funcall on-ready (list :success t :data (list :sessionFile "/elsewhere.jsonl")))
          (should (equal (plist-get (pi-orchestration--switch-state '(:id "s2")) :failure)
                         "Pi opened a different session file"))
          (pi-orchestration--switch (list :id "s3" :sessionFile file :cwd dir :args ["--model" "one"]
                                          :env '(:PI_CODING_AGENT_DIR "/agent")))
          (pi-orchestration--switch-state '(:id "s3" :close t))
          (should (equal closed (list chat))))
      (kill-buffer chat)
      (delete-directory dir t))))

(ert-deftest pi-orchestration-switch-reloads-an-idle-existing-view-and-refuses-a-busy-one ()
  (let* ((pi-orchestration--switches (make-hash-table :test 'equal))
         (dir (file-name-as-directory (pilish-test--make-temp-directory "pi-switch-reload-")))
         (file (expand-file-name "session.jsonl" dir))
         (pi-orchestration-show-session-function #'ignore)
         (reloads nil) (closed nil)
         (chat (generate-new-buffer "*pilish-chat:switch-existing*")))
    (write-region "" nil file)
    (with-current-buffer chat
      (pilish-chat-mode)
      (setq pilish--state (list :session-file file)))
    (unwind-protect
        (cl-letf (((symbol-function 'pilish-start-session)
                   (lambda (&rest _) (ert-fail "an open view must be reused")))
                  ((symbol-function 'pilish-session-pending-dialogs) (lambda (_) nil))
                  ((symbol-function 'pilish-close-session) (lambda (buffer) (push buffer closed)))
                  ((symbol-function 'pilish-reload)
                   (lambda (callback) (push (current-buffer) reloads) (funcall callback nil))))
          (with-current-buffer chat (setq pilish--status 'streaming))
          (should-error (pi-orchestration--switch (list :id "busy" :sessionFile file :cwd dir :args [] :env nil)))
          (should-not reloads)
          (with-current-buffer chat (setq pilish--status 'idle))
          (should (eq (plist-get (pi-orchestration--switch (list :id "r" :sessionFile file :cwd dir :args [] :env nil))
                                 :refreshed)
                      t))
          (should (equal reloads (list chat)))
          (should (eq (plist-get (pi-orchestration--switch-state '(:id "r" :close t)) :ready) t))
          (should-not closed))
      (kill-buffer chat)
      (delete-directory dir t))))

(provide 'pi-orchestration-test)
;;; pi-orchestration-test.el ends here
