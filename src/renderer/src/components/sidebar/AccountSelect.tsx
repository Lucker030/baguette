import type { Account } from '@shared/types'

interface AccountSelectProps {
  value: string
  accounts: Account[]
  onChange: (accountId: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLSelectElement>) => void
  /** `prefix` labels the options ("身分：預設帳號") in the create form. */
  prefix?: string
  className?: string
  title?: string
}

/** Account picker shared by the group-create form and the group rename row. */
export function AccountSelect({
  value,
  accounts,
  onChange,
  onKeyDown,
  prefix = '',
  className,
  title
}: AccountSelectProps): JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      title={title}
      className={className}
    >
      <option value="default">{prefix}預設帳號</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {prefix}
          {a.label}
        </option>
      ))}
    </select>
  )
}
