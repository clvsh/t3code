# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, and Cursor; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. When Claude is selected, this mode is
shown as **Codex Review**. Claude first applies its normal permission rules, then T3 sends any
remaining tool request to an isolated Codex reviewer for a one-time allow, deny, or request for
your approval. Reviews do not create session-wide grants.

T3 prefers the enabled default Codex account for these reviews. When no enabled default account
is configured, it can use one enabled custom Codex account; multiple custom accounts are
ambiguous. A missing, signed-out, or failed reviewer, a timeout, or an invalid response opens the
normal approval prompt instead.

For Grok, **Always allow this session** remembers the matching command or tool input. Other
actions still require approval.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.
