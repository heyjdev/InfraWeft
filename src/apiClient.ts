import { API_TOKEN_FRAGMENT, API_TOKEN_HEADER } from '../shared/access'

const SESSION_TOKEN_KEY = 'infraweft-api-token'

function loadAccessToken() {
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const launchedToken = fragment.get(API_TOKEN_FRAGMENT)
  if (launchedToken) {
    sessionStorage.setItem(SESSION_TOKEN_KEY, launchedToken)
    fragment.delete(API_TOKEN_FRAGMENT)
    const remainingFragment = fragment.toString()
    history.replaceState(null, '', `${location.pathname}${location.search}${remainingFragment ? `#${remainingFragment}` : ''}`)
  }
  return launchedToken || sessionStorage.getItem(SESSION_TOKEN_KEY)
}

const apiToken = loadAccessToken()

export function apiFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (apiToken) headers.set(API_TOKEN_HEADER, apiToken)
  return fetch(input, { ...init, headers })
}
