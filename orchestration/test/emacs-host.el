;;; lifecycle-emacs.el --- Disposable native lifecycle fixture -*- lexical-binding: t; -*-

;;; Commentary:
;; Loaded only by the private daemon owned by lifecycle-smoke.test.ts.

;;; Code:

(require 'package)
(setq package-user-dir (or (getenv "PI_LIFECYCLE_ELPA")
                           (expand-file-name "elpa/30.2/develop" user-emacs-directory))
      load-prefer-newer t)
(package-initialize)
(add-to-list 'load-path (or (getenv "PI_LIFECYCLE_PILISH")
                            (expand-file-name "~/.local/share/pilish")))
(require 'pilish)
(setq pilish-extra-args nil)

(defun pi-lifecycle-input (encoded)
  "Read or change an owned input buffer using base64 JSON ENCODED."
  (let* ((data (json-parse-string
                (decode-coding-string (base64-decode-string encoded) 'utf-8)
                :object-type 'plist))
         (target (gethash (plist-get data :id) pi-orchestration--targets))
         (input (pilish-session-input-buffer (plist-get target :buffer))))
    (unless (buffer-live-p input) (error "Missing lifecycle target input"))
    (with-current-buffer input
      (when (plist-member data :text)
        (erase-buffer)
        (insert (plist-get data :text)))
      (when (eq (plist-get data :send) t) (pilish-send))
      (base64-encode-string (encode-coding-string (buffer-string) 'utf-8) t))))

(provide 'lifecycle-emacs)
;;; lifecycle-emacs.el ends here
