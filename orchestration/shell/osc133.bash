# OSC 133 shell integration for interactive bash 4.4+.
#
# Marks prompt start (A), input end (B), command start (C) and command end
# (D;<exit status>) in the terminal output, so terminals and Pi's `wait` tool
# can tell when a command typed at the prompt has finished, also over ssh.
# fish 4+ emits these marks by itself. Source this file at the end of
# ~/.bashrc, after anything else that assigns PS1, PS0 or PROMPT_COMMAND.

[[ $- == *i* ]] || return 0
[[ -z ${__pi_osc133+x} ]] || return 0
__pi_osc133=1

__pi_osc133_prompt() {
  local status=$?
  printf '\e]133;D;%s\a\e]133;A\a' "$status"
  return "$status"
}

# The status must be read before any other prompt command runs.
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
  PROMPT_COMMAND=(__pi_osc133_prompt "${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__pi_osc133_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
PS1+='\[\e]133;B\a\]'
PS0+=$'\e]133;C\a'
