interface ToggleProps {
  on: boolean
  onChange: (next: boolean) => void
  title?: string
}

/** Sliding on/off switch. Off = black, On = blue, knob slides left↔right. */
export function Toggle({ on, onChange, title }: ToggleProps): JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      title={title ?? (on ? '啟動中（點一下關閉）' : '已關閉（點一下啟動）')}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!on)
      }}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${
        on ? 'border-[#1f6feb] bg-[#1f6feb]' : 'border-line bg-black'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          on ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}
