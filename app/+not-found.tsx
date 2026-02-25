import { useEffect } from 'react'
import { useGlobalSearchParams } from 'expo-router'

// Catch-all to prevent Expo Router from crashing on pear:// deep links
export default function NotFound() {
  return null
}
