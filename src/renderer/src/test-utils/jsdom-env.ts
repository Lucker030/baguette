import { JSDOM } from 'jsdom'

/**
 * Installs DOM globals for renderer tests, as a plain side-effect import.
 *
 * Why not just `// @vitest-environment jsdom`? Vitest puts non-node
 * environments through its *web* transform pipeline, whose module ids are
 * URL-shaped. On this machine the project is deliberately run from a Windows
 * 8.3 SHORT path (the user profile contains CJK characters that Node's loader
 * crashes on — see tools/README.md), and those URL-shaped ids resolve back to
 * either a drive-letter-less `/src/...` or the long CJK path, so *every* file
 * in a jsdom environment fails to load with "Cannot find module".
 *
 * Constructing JSDOM ourselves keeps the whole suite in the `node`
 * environment — ordinary filesystem module resolution, which works — while
 * still giving React and @testing-library a real DOM.
 *
 * Import this FIRST in a renderer test, before @testing-library/react, so the
 * globals exist by the time that module initializes.
 */
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
})

const g = globalThis as unknown as Record<string, unknown>

function define(key: string, value: unknown): void {
  Object.defineProperty(g, key, { value, writable: true, configurable: true })
}

define('window', dom.window)
define('document', dom.window.document)
// Node 22 exposes a read-only global `navigator`; defineProperty overrides it.
define('navigator', dom.window.navigator)

// Copy the DOM constructors and helpers React/testing-library reach for
// (HTMLElement, Node, Event, getComputedStyle, requestAnimationFrame, ...)
// without clobbering anything Node already provides.
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in g) continue
  const value = (dom.window as unknown as Record<string, unknown>)[key]
  if (typeof value === 'function' || typeof value === 'object') define(key, value)
}

// React's `act()` requires this flag to be set in a test environment.
define('IS_REACT_ACT_ENVIRONMENT', true)

export { dom }
