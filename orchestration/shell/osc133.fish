# OSC 133 shell integration for interactive fish 3.x.
#
# Marks prompt start (A), command start (C, with the URL-encoded command line)
# and command end (D;<exit status>) in the terminal output, so terminals and
# Pi's `wait` tool can tell when a command typed at the prompt has finished,
# also over ssh. fish 4+ emits these marks itself, so this file does nothing
# there. Source it from ~/.config/fish/config.fish.

status is-interactive; or return 0
set -q __pi_osc133; and return 0
test (string split -f1 . $version) -ge 4; and return 0
set -g __pi_osc133 1

function __pi_osc133_prompt --on-event fish_prompt
    printf '\e]133;A\a'
end

function __pi_osc133_preexec --on-event fish_preexec
    printf '\e]133;C;cmdline_url=%s\a' (string escape --style=url -- $argv[1])
end

function __pi_osc133_postexec --on-event fish_postexec
    printf '\e]133;D;%s\a' $status
end
