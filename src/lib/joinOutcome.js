// TODO #145 - a failed join has to say something true, and something the person
// can act on.
//
// handleInviteLink already distinguishes a dozen outcomes and
// repairKeylessGroupFromInvite already returns a `reason` whose own comment says
// it exists "so the UI can say something honest either way". The UI never used
// either: the join sheet closed silently on `already_member`, and everything
// else collapsed into "Check the invite link and try again" - which is actively
// wrong when the link is perfect and the repair is what failed.
//
// The cost of that silence is not hypothetical. A genuinely failed join looked
// exactly like a clean one twice while chasing #123 and #148, and both times it
// took a logcat dig to find out which had happened.
//
// Kept pure and separate so the wording is testable without a WebView, and so
// there is one place to be right about which outcome maps to which advice.

'use strict'

// What the user should be told, and whether it is bad news.
//
//   { message, tone }   tone: 'error' | 'warn' | 'info'
//
// `info` is deliberate: some outcomes are not failures at all from the user's
// point of view. Being told "you are already in this group" is an answer, not an
// error, and colouring it red would train people to ignore red.
function joinOutcomeMessage ({ error, reason, groupName } = {}) {
  const name = groupName ? `"${groupName}"` : 'that group'

  switch (error) {
    case 'blocked_from_group':
      return { tone: 'error', message: `You were removed from ${name}, so this invite will not work. Ask whoever runs the group to invite you again.` }

    case 'already_member':
      return { tone: 'info', message: `You are already in ${name}.` }

    // handleInviteLink threw rather than returning. Before this was caught, the
    // sheet spun forever with nothing said, because the caller only ever reacted
    // to a returned result.
    case 'join_threw':
      return { tone: 'error', message: `Something went wrong joining ${name}. Try the link again, and if it keeps failing ask for a fresh one.` }

    case 'repair_failed':
      // The group is one this device cannot decrypt, and the fresh invite that
      // should have cured it did not. Each reason is a genuinely different
      // story, which is the whole point of surfacing it (TODO #124/#123).
      switch (reason) {
        case 'key-conflict':
          return { tone: 'error', message: `This invite is for a different version of ${name} than the one on this device. Ask the sender to remove you from the group and invite you back.` }
        case 'not-a-member':
          return { tone: 'error', message: `${name} is no longer on this device, so there was nothing to repair. Ask for a fresh invite link to join again.` }
        case 'already-keyed':
          return { tone: 'info', message: `${name} is already working on this device. Nothing needed repairing.` }
        case 'missing-args':
          return { tone: 'error', message: `That invite link is missing the part needed to repair ${name}. Ask the sender for a new one.` }
        case 'reconcile-failed':
        default:
          return { tone: 'error', message: `Could not repair ${name} on this device. Try the link again, and if it still fails ask the sender to re-share it.` }
      }

    // Every parse failure from parseInviteLink. Distinct from the above: here
    // the link itself is the problem, so "check the link" is the right advice
    // rather than the catch-all it used to be.
    case 'invalid_url':
    case 'malformed_url':
    case 'wrong_path':
    case 'missing_params':
    case 'invalid_group_id':
    case 'empty_name':
    case 'invalid_key':
    case 'invalid_inviter':
    case 'invalid_enc':
      return { tone: 'error', message: 'That invite link does not look right. Ask for a new one and paste the whole thing.' }

    default:
      // Unknown code. Say so plainly rather than inventing a cause - an honest
      // "something went wrong" beats a confident wrong diagnosis, and the code
      // is included so a report names it.
      return { tone: 'error', message: `Could not join ${name}${error ? ` (${error})` : ''}. Try again, or ask for a fresh invite link.` }
  }
}

// May the join sheet close on this outcome?
//
// Only for the genuinely-nothing-wrong cases. Note this decides CLOSING, not
// silence: the message above is shown either way. Closing while saying nothing
// is exactly what made these dead ends invisible, and a benign outcome the user
// never sees is still a question left unanswered.
function isBenignJoinOutcome ({ error, reason } = {}) {
  if (error === 'already_member') return true
  if (error === 'repair_failed' && reason === 'already-keyed') return true
  return false
}

module.exports = {
  joinOutcomeMessage,
  isBenignJoinOutcome,
}
