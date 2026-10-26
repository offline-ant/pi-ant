# OSC 133 prompt marks for gdb.
#
# Marks command end (D) and prompt start (A) before gdb's prompt and input end
# (B) after it, so terminals and Pi's panel-send/wait tools can tell when a typed
# gdb command has finished, including `run`/`continue` until the program stops.
# gdb cannot report command failures or command starts, so D carries no exit
# status and no C is emitted. Load it with `gdb -x <this file>` or `source` it
# from ~/.gdbinit; it replaces the prompt. \001 and \002 tell readline that the
# marks take no screen space.
#
# Pager (`--Type <RET> for more`) and confirmation (`(y or n)`) questions show no
# prompt marks; for unattended use also pass
# `-ex 'set pagination off' -ex 'set confirm off'`.

set prompt \001\033]133;D\007\033]133;A\007\002(gdb) \001\033]133;B\007\002
