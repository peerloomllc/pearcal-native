import { useEffect } from 'react'
import { useLocalSearchParams, router } from 'expo-router'
import { DeviceEventEmitter } from 'react-native'

export default function JoinRoute() {
  const params = useLocalSearchParams()

  useEffect(() => {
    // Reconstruct the full pear:// URL and emit it for our handler
    const qs = new URLSearchParams(params as Record<string, string>).toString()
    const url = `pear://pearcal/join?${qs}`
    DeviceEventEmitter.emit('pearLink', url)
    // Navigate back to main app
    router.replace('/')
  }, [])

  return null
}
