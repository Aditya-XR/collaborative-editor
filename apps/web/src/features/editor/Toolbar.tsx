import { useEditorState, type Editor } from '@tiptap/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { isWebAddress } from './extensions'
import { MOD } from './keys'
import { ShortcutsDialog } from './ShortcutsDialog'

interface Tool {
  label: string
  text: string
  /** Shown in the tooltip, e.g. "Ctrl+B". */
  keys?: string
  isActive?: (editor: Editor) => boolean
  run: (editor: Editor) => void
  canRun?: (editor: Editor) => boolean
}

type Asking = 'link' | 'image' | null

const GROUPS: Tool[][] = [
  [
    {
      label: 'Undo',
      text: '↶',
      keys: `${MOD}+Z`,
      run: (e) => e.chain().focus().undo().run(),
      canRun: (e) => e.can().undo(),
    },
    {
      label: 'Redo',
      text: '↷',
      keys: `${MOD}+Shift+Z`,
      run: (e) => e.chain().focus().redo().run(),
      canRun: (e) => e.can().redo(),
    },
  ],
  [
    {
      label: 'Heading 1',
      text: 'H1',
      keys: `${MOD}+Alt+1`,
      isActive: (e) => e.isActive('heading', { level: 1 }),
      run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      label: 'Heading 2',
      text: 'H2',
      keys: `${MOD}+Alt+2`,
      isActive: (e) => e.isActive('heading', { level: 2 }),
      run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    },
  ],
  [
    {
      label: 'Bold',
      text: 'B',
      keys: `${MOD}+B`,
      isActive: (e) => e.isActive('bold'),
      run: (e) => e.chain().focus().toggleBold().run(),
    },
    {
      label: 'Italic',
      text: 'I',
      keys: `${MOD}+I`,
      isActive: (e) => e.isActive('italic'),
      run: (e) => e.chain().focus().toggleItalic().run(),
    },
    {
      label: 'Underline',
      text: 'U',
      keys: `${MOD}+U`,
      isActive: (e) => e.isActive('underline'),
      run: (e) => e.chain().focus().toggleUnderline().run(),
    },
    {
      label: 'Strikethrough',
      text: 'S',
      keys: `${MOD}+Shift+S`,
      isActive: (e) => e.isActive('strike'),
      run: (e) => e.chain().focus().toggleStrike().run(),
    },
    {
      label: 'Inline code',
      text: '</>',
      keys: `${MOD}+E`,
      isActive: (e) => e.isActive('code'),
      run: (e) => e.chain().focus().toggleCode().run(),
    },
  ],
  [
    {
      label: 'Bullet list',
      text: '•',
      keys: `${MOD}+Shift+8`,
      isActive: (e) => e.isActive('bulletList'),
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      label: 'Numbered list',
      text: '1.',
      keys: `${MOD}+Shift+7`,
      isActive: (e) => e.isActive('orderedList'),
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      label: 'Checklist',
      text: '☑',
      keys: `${MOD}+Shift+9`,
      isActive: (e) => e.isActive('taskList'),
      run: (e) => e.chain().focus().toggleTaskList().run(),
    },
    {
      label: 'Quote',
      text: '❝',
      keys: `${MOD}+Shift+B`,
      isActive: (e) => e.isActive('blockquote'),
      run: (e) => e.chain().focus().toggleBlockquote().run(),
    },
    {
      label: 'Code block',
      text: '{ }',
      keys: `${MOD}+Alt+C`,
      isActive: (e) => e.isActive('codeBlock'),
      run: (e) => e.chain().focus().toggleCodeBlock().run(),
    },
  ],
  [
    {
      label: 'Table',
      text: '▦',
      run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      canRun: (e) => e.can().insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
    },
    {
      label: 'Divider',
      text: '―',
      run: (e) => e.chain().focus().setHorizontalRule().run(),
    },
  ],
]

/** Shown while the cursor is in a table. */
const TABLE_TOOLS: Tool[] = [
  {
    label: 'Add row below',
    text: '+ Row',
    run: (e) => e.chain().focus().addRowAfter().run(),
    canRun: (e) => e.can().addRowAfter(),
  },
  {
    label: 'Add column right',
    text: '+ Column',
    run: (e) => e.chain().focus().addColumnAfter().run(),
    canRun: (e) => e.can().addColumnAfter(),
  },
  {
    label: 'Delete row',
    text: '− Row',
    run: (e) => e.chain().focus().deleteRow().run(),
    canRun: (e) => e.can().deleteRow(),
  },
  {
    label: 'Delete column',
    text: '− Column',
    run: (e) => e.chain().focus().deleteColumn().run(),
    canRun: (e) => e.can().deleteColumn(),
  },
  {
    label: 'Delete table',
    text: 'Delete table',
    run: (e) => e.chain().focus().deleteTable().run(),
    canRun: (e) => e.can().deleteTable(),
  },
]

const BUTTON_CLASS =
  'min-w-8 rounded-md px-2 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 aria-pressed:bg-indigo-100 aria-pressed:text-indigo-700 dark:text-slate-200 dark:hover:bg-slate-800 dark:aria-pressed:bg-indigo-950 dark:aria-pressed:text-indigo-300'

function ToolButton({
  tool,
  active,
  enabled,
  onRun,
}: {
  tool: Tool
  active: boolean
  enabled: boolean
  onRun: () => void
}) {
  return (
    <button
      type="button"
      aria-label={tool.label}
      title={tool.keys ? `${tool.label} (${tool.keys})` : tool.label}
      aria-pressed={tool.isActive ? active : undefined}
      disabled={!enabled}
      onClick={onRun}
      className={BUTTON_CLASS}
    >
      {tool.text}
    </button>
  )
}

export function Toolbar({ editor }: { editor: Editor }) {
  const [asking, setAsking] = useState<Asking>(null)
  const [shortcuts, setShortcuts] = useState(false)
  // Re-render on selection changes so active states stay accurate.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      tools: GROUPS.flat().map((tool) => ({
        active: tool.isActive?.(e) ?? false,
        enabled: tool.canRun?.(e) ?? true,
      })),
      inTable: e.isActive('table'),
      tableTools: TABLE_TOOLS.map((tool) => tool.canRun?.(e) ?? true),
      link: e.isActive('link'),
    }),
  })

  // Ctrl+K (Cmd+K) adds or edits a link, as in most editors.
  useEffect(() => {
    const dom = editor.view.dom
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault()
        setAsking('link')
      }
    }
    dom.addEventListener('keydown', onKeyDown)
    return () => dom.removeEventListener('keydown', onKeyDown)
  }, [editor])

  let index = 0
  return (
    <div className="border-b border-slate-200 dark:border-slate-800">
      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex flex-wrap items-center gap-1 px-2 py-1.5"
      >
        {GROUPS.map((group, groupIndex) => (
          <div
            key={groupIndex}
            className="flex gap-0.5 border-r border-slate-200 pr-1 dark:border-slate-700"
          >
            {group.map((tool) => {
              const { active, enabled } = state.tools[index++]
              return (
                <ToolButton
                  key={tool.label}
                  tool={tool}
                  active={active}
                  enabled={enabled}
                  onRun={() => tool.run(editor)}
                />
              )
            })}
          </div>
        ))}
        <div className="flex gap-0.5 border-r border-slate-200 pr-1 dark:border-slate-700">
          <button
            type="button"
            aria-label="Link"
            title={`Link (${MOD}+K)`}
            aria-pressed={state.link}
            onClick={() => setAsking(asking === 'link' ? null : 'link')}
            className={BUTTON_CLASS}
          >
            🔗
          </button>
          <button
            type="button"
            aria-label="Image"
            title="Image from a web address"
            onClick={() => setAsking(asking === 'image' ? null : 'image')}
            className={BUTTON_CLASS}
          >
            🖼
          </button>
        </div>
        <button
          type="button"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
          onClick={() => setShortcuts(true)}
          className={BUTTON_CLASS}
        >
          ?
        </button>
      </div>
      {state.inTable && (
        <div
          role="toolbar"
          aria-label="Table"
          className="flex flex-wrap gap-0.5 border-t border-slate-100 px-2 py-1 dark:border-slate-800"
        >
          {TABLE_TOOLS.map((tool, i) => (
            <ToolButton
              key={tool.label}
              tool={tool}
              active={false}
              enabled={state.tableTools[i]}
              onRun={() => tool.run(editor)}
            />
          ))}
        </div>
      )}
      {asking && (
        <AddressForm
          key={asking}
          kind={asking}
          editor={editor}
          initial={asking === 'link' ? ((editor.getAttributes('link').href as string) ?? '') : ''}
          onDone={() => setAsking(null)}
        />
      )}
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
    </div>
  )
}

/** Asks for the address of a link or an image, in place of a browser prompt. */
function AddressForm({
  kind,
  editor,
  initial,
  onDone,
}: {
  kind: 'link' | 'image'
  editor: Editor
  initial: string
  onDone: () => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const address = value.trim()
    if (kind === 'link' && !address) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return onDone()
    }
    if (!isWebAddress(address)) {
      setError('Enter a full web address, starting with https://')
      return
    }
    if (kind === 'link') {
      editor.chain().focus().extendMarkRange('link').setLink({ href: address }).run()
    } else {
      editor.chain().focus().setImage({ src: address }).run()
    }
    onDone()
  }

  const label = kind === 'link' ? 'Link address' : 'Image address'
  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-3 py-2 dark:border-slate-800"
    >
      <input
        ref={input}
        type="url"
        aria-label={label}
        placeholder={kind === 'link' ? 'https://example.com' : 'https://example.com/picture.png'}
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            editor.commands.focus()
            onDone()
          }
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'address-error' : undefined}
        className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-900"
      />
      <button type="submit" className={BUTTON_CLASS}>
        {kind === 'link' ? (value.trim() || !initial ? 'Apply' : 'Remove link') : 'Insert'}
      </button>
      <button type="button" onClick={onDone} className={BUTTON_CLASS}>
        Cancel
      </button>
      {error && (
        <p id="address-error" role="alert" className="w-full text-xs text-rose-600">
          {error}
        </p>
      )}
    </form>
  )
}
