import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { describeError } from '../../lib/errors'
import { timeAgo } from '../../lib/time'
import type { User } from '../auth/session'
import type { DocumentSummary, Role } from '../documents/api'
import {
  LINK_EXPIRY,
  SHARE_ROLES,
  shareUrl,
  sharingApi,
  type CreatedLink,
  type Member,
  type ShareRole,
} from './api'
import { useLinks, useMembers, useSharingMutation } from './queries'

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  editor: 'Editor',
  commenter: 'Commenter',
  viewer: 'Viewer',
}

const selectClass =
  'rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900'

export function ShareDialog({
  document,
  currentUser,
  role,
  onClose,
}: {
  document: DocumentSummary
  currentUser: User
  role: Role
  onClose: () => void
}) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const canManage = role === 'owner' || role === 'editor'

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    globalThis.addEventListener('keydown', onKey)
    panel.current?.querySelector<HTMLElement>('input, button')?.focus()
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 pt-[10vh]"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold">
            Share “{document.title}”
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close sharing">
            ✕
          </Button>
        </div>
        {canManage && <InviteForm documentId={document.id} />}
        <People document={document} currentUser={currentUser} role={role} />
        {canManage && <Links documentId={document.id} />}
      </div>
    </div>
  )
}

function InviteForm({ documentId }: { documentId: string }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<ShareRole>('editor')
  const invite = useSharingMutation(documentId, () => sharingApi.invite(documentId, email, role))

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await invite.mutateAsync(undefined).then(
      () => setEmail(''),
      () => undefined,
    )
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Add people by email"
          aria-label="Email to invite"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
        <select
          aria-label="Role for the invite"
          value={role}
          onChange={(event) => setRole(event.target.value as ShareRole)}
          className={selectClass}
        >
          {SHARE_ROLES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Button type="submit" busy={invite.isPending} disabled={!email}>
          Invite
        </Button>
      </div>
      {invite.isError && <Alert>{describeError(invite.error)}</Alert>}
    </form>
  )
}

function People({
  document,
  currentUser,
  role,
}: {
  document: DocumentSummary
  currentUser: User
  role: Role
}) {
  const members = useMembers(document.id)
  return (
    <section className="mt-6">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
        People with access
      </h3>
      {members.isError && <Alert>{describeError(members.error)}</Alert>}
      <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
        {members.data?.map((member) => (
          <PersonRow
            key={member.user.id}
            documentId={document.id}
            member={member}
            isSelf={member.user.id === currentUser.id}
            viewerIsOwner={role === 'owner'}
          />
        ))}
      </ul>
    </section>
  )
}

function PersonRow({
  documentId,
  member,
  isSelf,
  viewerIsOwner,
}: {
  documentId: string
  member: Member
  isSelf: boolean
  viewerIsOwner: boolean
}) {
  const navigate = useNavigate()
  const [confirmingTransfer, setConfirmingTransfer] = useState(false)
  const userId = member.user.id
  const changeRole = useSharingMutation(documentId, (next: ShareRole) =>
    sharingApi.changeRole(documentId, userId, next),
  )
  const remove = useSharingMutation(documentId, () => sharingApi.remove(documentId, userId))
  const transfer = useSharingMutation(documentId, () => sharingApi.transfer(documentId, userId))
  const error = changeRole.error ?? remove.error ?? transfer.error
  const isOwner = member.role === 'owner'
  const manage = viewerIsOwner && !isOwner

  return (
    <li className="py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {member.user.name}
            {isSelf && <span className="text-slate-500"> (you)</span>}
          </p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{member.user.email}</p>
        </div>
        {manage ? (
          <>
            <select
              aria-label={`Role for ${member.user.name}`}
              value={member.role}
              onChange={(event) => changeRole.mutate(event.target.value as ShareRole)}
              className={selectClass}
            >
              {SHARE_ROLES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              onClick={() => setConfirmingTransfer(true)}
              aria-label={`Make ${member.user.name} the owner`}
            >
              Make owner
            </Button>
            <Button
              variant="danger"
              busy={remove.isPending}
              onClick={() => remove.mutate(undefined)}
              aria-label={`Remove ${member.user.name}`}
            >
              Remove
            </Button>
          </>
        ) : (
          <span className="text-sm text-slate-600 dark:text-slate-300">
            {ROLE_LABEL[member.role]}
          </span>
        )}
        {isSelf && !isOwner && (
          <Button
            variant="danger"
            busy={remove.isPending}
            onClick={() =>
              remove.mutateAsync(undefined).then(
                () => navigate('/'),
                () => {},
              )
            }
          >
            Leave
          </Button>
        )}
      </div>
      {confirmingTransfer && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="flex-1">Make {member.user.name} the owner? You will become an editor.</p>
          <Button variant="secondary" onClick={() => setConfirmingTransfer(false)}>
            Cancel
          </Button>
          <Button
            busy={transfer.isPending}
            onClick={() => transfer.mutateAsync(undefined).then(() => setConfirmingTransfer(false))}
          >
            Transfer
          </Button>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <Alert>{describeError(error)}</Alert>
        </div>
      )}
    </li>
  )
}

function Links({ documentId }: { documentId: string }) {
  const links = useLinks(documentId, true)
  const [role, setRole] = useState<ShareRole>('viewer')
  const [expiry, setExpiry] = useState<string>('7')
  const [created, setCreated] = useState<CreatedLink | null>(null)
  const [copied, setCopied] = useState(false)
  const create = useSharingMutation(documentId, () =>
    sharingApi.createLink(documentId, role, expiry === 'never' ? null : Number(expiry)),
  )
  const revoke = useSharingMutation(documentId, (linkId: string) =>
    sharingApi.revokeLink(documentId, linkId),
  )

  async function onCreate() {
    setCopied(false)
    setCreated(await create.mutateAsync(undefined))
  }

  async function onCopy(url: string) {
    await navigator.clipboard?.writeText(url)
    setCopied(true)
  }

  return (
    <section className="mt-6">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Share links</h3>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Anyone signed in who opens the link gets the role you choose.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <select
          aria-label="Role for the link"
          value={role}
          onChange={(event) => setRole(event.target.value as ShareRole)}
          className={selectClass}
        >
          {SHARE_ROLES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Link expires after"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          className={selectClass}
        >
          {LINK_EXPIRY.map((option) => (
            <option key={option.label} value={option.value ?? 'never'}>
              {option.value ? `Expires in ${option.label}` : 'Never expires'}
            </option>
          ))}
        </select>
        <Button variant="secondary" busy={create.isPending} onClick={onCreate}>
          Create link
        </Button>
      </div>
      {created && (
        <div className="mt-3 flex gap-2">
          <input
            readOnly
            aria-label="New share link"
            value={shareUrl(created.token)}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <Button onClick={() => onCopy(shareUrl(created.token))}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      {(create.error ?? revoke.error) && (
        <div className="mt-2">
          <Alert>{describeError(create.error ?? revoke.error)}</Alert>
        </div>
      )}
      {links.data && links.data.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {links.data.map((link) => (
            <li key={link.id} className="flex items-center gap-3 py-2">
              <span className="flex-1 text-slate-600 dark:text-slate-300">
                {ROLE_LABEL[link.role]} link · created {timeAgo(link.created_at)} ·{' '}
                {link.expires_at ? `expires ${timeAgo(link.expires_at)}` : 'never expires'}
              </span>
              <Button
                variant="danger"
                onClick={() => revoke.mutate(link.id)}
                aria-label={`Turn off ${ROLE_LABEL[link.role].toLowerCase()} link`}
              >
                Turn off
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
