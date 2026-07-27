import { Redirect } from 'expo-router'

// TODO #144 - this route used to park the app on a blank screen that only a
// force-stop could clear.
//
// It rendered an empty dark View, waited 2s, emitted a `pearLink` DeviceEvent,
// and never navigated anywhere. Two things were wrong with that:
//
//   1. NOTHING LISTENS FOR `pearLink`. There is not one addListener for it
//      anywhere in the app, so the emit was dead code and this route delivered
//      nothing at all. The URL reaches the app by a completely different path -
//      the native LinkModule captures the VIEW intent and the index screen
//      polls getPendingLink() - which is why https invites worked and the
//      legacy schemes dead-ended here.
//   2. It never navigated away, so it sat on top of whatever it had triggered.
//      On a cold start it is the only entry in the stack, so Back exits the app
//      rather than going anywhere useful.
//
// So this route's entire job is to get out of the way, handing off to the index
// screen which owns the WebView and the poller that actually delivers the
// invite.
//
// `<Redirect>` rather than `router.replace()` in an effect, and that distinction
// is not cosmetic: a cold open lands here BEFORE the root navigator has mounted,
// so the imperative call throws "Attempted to navigate before mounting the Root
// Layout component" and leaves a redbox where the blank screen used to be.
// Caught on the TCL, not by reading. Redirect is declarative and expo-router
// defers it until the navigator is ready.
export default function JoinRoute() {
  return <Redirect href="/" />
}
