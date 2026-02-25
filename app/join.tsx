import { useEffect } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { DeviceEventEmitter, View } from 'react-native'

export default function JoinRoute() {
  const params = useLocalSearchParams<Record<string, string>>()

  useEffect(() => {
    const entries = Object.entries(params)
      .filter(([k]) => k !== 'screen')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    const url = `pear://pearcal/join?${entries}`
    console.log('JoinRoute emitting pearLink:', url)

    // Delay to ensure WebView is mounted
    setTimeout(() => {
      DeviceEventEmitter.emit('pearLink', url)
    }, 2000)
  }, [])

  return <View style={{ flex: 1, backgroundColor: '#111' }} />
}
