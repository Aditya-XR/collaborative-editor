import { useEditorState, type Editor } from '@tiptap/react'

interface Tool {
  label: string
  text: string
  isActive?: (editor: Editor) => boolean
  run: (editor: Editor) => void
  canRun?: (editor: Editor) => boolean
}

const GROUPS: Tool[][] = [
  [
    {
      label: 'Undo',
      text: '↶',
      run: (e) => e.chain().focus().undo().run(),
      canRun: (e) => e.can().undo(),
    },
    {
      label: 'Redo',
      text: '↷',
      run: (e) => e.chain().focus().redo().run(),
      canRun: (e) => e.can().redo(),
    },
  ],
  [
    {
      label: 'Heading 1',
      text: 'H1',
      isActive: (e) => e.isActive('heading', { level: 1 }),
      run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      label: 'Heading 2',
      text: 'H2',
      isActive: (e) => e.isActive('heading', { level: 2 }),
      run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    },
  ],
  [
    {
      label: 'Bold',
      text: 'B',
      isActive: (e) => e.isActive('bold'),
      run: (e) => e.chain().focus().toggleBold().run(),
    },
    {
      label: 'Italic',
      text: 'I',
      isActive: (e) => e.isActive('italic'),
      run: (e) => e.chain().focus().toggleItalic().run(),
    },
    {
      label: 'Strikethrough',
      text: 'S',
      isActive: (e) => e.isActive('strike'),
      run: (e) => e.chain().focus().toggleStrike().run(),
    },
    {
      label: 'Inline code',
      text: '</>',
      isActive: (e) => e.isActive('code'),
      run: (e) => e.chain().focus().toggleCode().run(),
    },
  ],
  [
    {
      label: 'Bullet list',
      text: '•',
      isActive: (e) => e.isActive('bulletList'),
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      label: 'Numbered list',
      text: '1.',
      isActive: (e) => e.isActive('orderedList'),
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      label: 'Quote',
      text: '❝',
      isActive: (e) => e.isActive('blockquote'),
      run: (e) => e.chain().focus().toggleBlockquote().run(),
    },
    {
      label: 'Code block',
      text: '{ }',
      isActive: (e) => e.isActive('codeBlock'),
      run: (e) => e.chain().focus().toggleCodeBlock().run(),
    },
  ],
]

export function Toolbar({ editor }: { editor: Editor }) {
  // Re-render on selection changes so active states stay accurate.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      GROUPS.flat().map((tool) => ({
        active: tool.isActive?.(e) ?? false,
        enabled: tool.canRun?.(e) ?? true,
      })),
  })

  let index = 0
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-slate-800"
    >
      {GROUPS.map((group, groupIndex) => (
        <div
          key={groupIndex}
          className="flex gap-0.5 border-r border-slate-200 pr-1 last:border-0 dark:border-slate-700"
        >
          {group.map((tool) => {
            const { active, enabled } = state[index++]
            return (
              <button
                key={tool.label}
                type="button"
                aria-label={tool.label}
                title={tool.label}
                aria-pressed={tool.isActive ? active : undefined}
                disabled={!enabled}
                onClick={() => tool.run(editor)}
                className="min-w-8 rounded-md px-2 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 aria-pressed:bg-indigo-100 aria-pressed:text-indigo-700 dark:text-slate-200 dark:hover:bg-slate-800 dark:aria-pressed:bg-indigo-950 dark:aria-pressed:text-indigo-300"
              >
                {tool.text}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
