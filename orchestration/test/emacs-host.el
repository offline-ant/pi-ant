;;; emacs-host.el --- Disposable native Emacs host fixture -*- lexical-binding: t; -*-

;;; Commentary:
;; Loaded only by private daemons that native tests own (`emacs -Q
;; --daemon=<socket> -l emacs-host.el'): Pilish, ghostel and the
;; orchestration companion, without the user's configuration.  Packages come
;; from PI_EMACS_ELPA (default ~/.emacs.d/elpa), Pilish from PI_EMACS_PILISH
;; (default: the workspace checkout beside pi-ant) and ghostel's native module
;; from PI_EMACS_GHOSTEL_MODULE (default ~/.emacs.d/var/ghostel/).

;;; Code:

(require 'package)
(setq package-user-dir (or (getenv "PI_EMACS_ELPA")
                           (expand-file-name "elpa" user-emacs-directory))
      load-prefer-newer t)
(package-initialize)
(defconst pi-emacs-host--directory
  (file-name-directory (or load-file-name buffer-file-name)))
(add-to-list 'load-path (or (getenv "PI_EMACS_PILISH")
                            (expand-file-name "../../../pilish" pi-emacs-host--directory)))
(add-to-list 'load-path (expand-file-name "../emacs" pi-emacs-host--directory))
(setq ghostel-module-directory
      (or (getenv "PI_EMACS_GHOSTEL_MODULE")
          (expand-file-name "var/ghostel/" user-emacs-directory)))
(require 'pi-orchestration)
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

(provide 'emacs-host)
;;; emacs-host.el ends here
