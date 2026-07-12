import { Platform } from 'react-native'
import { requireOptionalNativeModule } from 'expo-modules-core'

// iOS-only native module (see ios/LocalNetworkModule.swift). On Android and web
// requireOptionalNativeModule returns null, so the export below is a no-op there.
const LocalNetwork = requireOptionalNativeModule<{
  requestPermission(): Promise<boolean>
}>('LocalNetwork')

// Trigger the iOS Local Network permission prompt so same-WiFi Hyperswarm peers
// can be reached directly instead of via a relay. Fire-and-forget: it starts a
// short-lived Bonjour probe on the native side and resolves immediately. No-op
// off iOS or when the native module is unavailable. Never throws.
export async function requestLocalNetworkPermission (): Promise<boolean> {
  if (Platform.OS !== 'ios' || !LocalNetwork) return false
  try {
    return await LocalNetwork.requestPermission()
  } catch {
    return false
  }
}
