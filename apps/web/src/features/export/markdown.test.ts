import type { JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { toMarkdown } from './markdown'

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const text = (
  value: string,
  ...marks: (string | [string, Record<string, unknown>])[]
): JSONContent => ({
  type: 'text',
  text: value,
  ...(marks.length > 0
    ? {
        marks: marks.map((mark) =>
          typeof mark === 'string' ? { type: mark } : { type: mark[0], attrs: mark[1] },
        ),
      }
    : {}),
})
const item = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content })

describe('toMarkdown', () => {
  it('writes headings, paragraphs and rules, a blank line apart', () => {
    expect(
      toMarkdown(
        doc(
          { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
          p(text('First.')),
          { type: 'horizontalRule' },
          p(),
          p(text('Last.')),
        ),
      ),
    ).toBe('## Plan\n\nFirst.\n\n---\n\nLast.\n')
  })

  it('nests marks, keeping shared ones open and spaces outside the delimiters', () => {
    expect(toMarkdown(doc(p(text('a ', 'bold'), text('b', 'bold', 'italic'), text(' c'))))).toBe(
      '**a *b*** c\n',
    )
    expect(toMarkdown(doc(p(text('gone', 'strike'), text(' '), text('under', 'underline'))))).toBe(
      '~~gone~~ <u>under</u>\n',
    )
  })

  it('writes links and code, with enough backticks', () => {
    expect(
      toMarkdown(
        doc(
          p(
            text('the ', ['link', { href: 'https://example.com/a b' }]),
            text('docs', ['link', { href: 'https://example.com/a b' }], 'bold'),
            text(' and '),
            text('x `y`', 'code'),
          ),
        ),
      ),
      // A code span that ends in a backtick is padded on both sides; CommonMark strips the pads.
    ).toBe('[the **docs**](<https://example.com/a b>) and `` x `y` ``\n')
  })

  it('escapes text Markdown would otherwise read as formatting', () => {
    expect(toMarkdown(doc(p(text('# not a heading, *not* bold, [not] a link <b>'))))).toBe(
      '\\# not a heading, \\*not\\* bold, \\[not\\] a link \\<b\\>\n',
    )
    expect(toMarkdown(doc(p(text('1. not a list'))))).toBe('1\\. not a list\n')
    expect(toMarkdown(doc(p(text('- not a list either'))))).toBe('\\- not a list either\n')
  })

  it('writes nested bullet, numbered and check lists', () => {
    const markdown = toMarkdown(
      doc(
        {
          type: 'bulletList',
          content: [
            item(p(text('one')), {
              type: 'orderedList',
              attrs: { start: 3 },
              content: [item(p(text('three'))), item(p(text('four')))],
            }),
            item(p(text('two'))),
          ],
        },
        {
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { checked: true }, content: [p(text('done'))] },
            { type: 'taskItem', attrs: { checked: false }, content: [p(text('to do'))] },
          ],
        },
      ),
    )
    expect(markdown).toBe('- one\n  3. three\n  4. four\n- two\n\n- [x] done\n- [ ] to do\n')
  })

  it('quotes every line of a quote, and fences code with its language', () => {
    expect(
      toMarkdown(
        doc(
          { type: 'blockquote', content: [p(text('said')), p(text('twice'))] },
          {
            type: 'codeBlock',
            attrs: { language: 'ts' },
            content: [text('const a = 1\n```\nconst b = 2')],
          },
        ),
      ),
    ).toBe('> said\n>\n> twice\n\n````ts\nconst a = 1\n```\nconst b = 2\n````\n')
  })

  it('writes line breaks, images and tables', () => {
    const markdown = toMarkdown(
      doc(
        p(text('line one'), { type: 'hardBreak' }, text('line two')),
        { type: 'image', attrs: { src: 'https://example.com/cat.png', alt: 'A cat', title: null } },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', content: [p(text('Name'))] },
                { type: 'tableHeader', content: [p(text('Cost'))] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [p(text('a|b'))] },
                { type: 'tableCell', content: [p(text('1')), p(text('2'))] },
              ],
            },
          ],
        },
      ),
    )
    expect(markdown).toBe(
      'line one\\\nline two\n\n![A cat](https://example.com/cat.png)\n\n' +
        '| Name | Cost |\n| --- | --- |\n| a\\|b | 1<br>2 |\n',
    )
  })

  it('writes nothing for an empty document', () => {
    expect(toMarkdown(doc())).toBe('')
    expect(toMarkdown(doc(p()))).toBe('')
  })
})
