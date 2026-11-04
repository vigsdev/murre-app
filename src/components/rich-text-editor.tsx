import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react"
import { Placeholder } from "@tiptap/extensions"
import StarterKit from "@tiptap/starter-kit"
import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
  type LucideIcon,
} from "lucide-react"
import { useEffect, useRef } from "react"
import { Separator } from "@/components/ui/separator"
import { Toggle } from "@/components/ui/toggle"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface Props {
  /** Initial document. To load a different document, remount with a new `key`. */
  content: JSONContent | null
  onChange: (doc: JSONContent) => void
  /** Called when the document contains content this editor cannot represent. */
  onContentError?: () => void
  disabled?: boolean
  placeholder?: string
  className?: string
}

export function RichTextEditor({ content, onChange, onContentError, disabled, placeholder = "Start writing…", className }: Props) {
  // Keep callbacks current without recreating the editor.
  const onChangeRef = useRef(onChange)
  const onErrorRef = useRef(onContentError)
  useEffect(() => {
    onChangeRef.current = onChange
    onErrorRef.current = onContentError
  })

  const editor = useEditor({
    // Links are left out on purpose: clicking one would navigate the app window.
    extensions: [StarterKit.configure({ link: false }), Placeholder.configure({ placeholder })],
    content: content ?? undefined,
    editable: !disabled,
    enableContentCheck: true,
    onContentError: () => onErrorRef.current?.(),
    onUpdate: ({ editor }) => onChangeRef.current(editor.getJSON()),
  })

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  return (
    // A dotted desk with a sheet of paper; the formatting bar is the top edge of the sheet and sticks while scrolling.
    <div className={cn("dot-bg flex flex-col overflow-y-auto px-4", className)}>
      <div className="mx-auto my-4 flex min-h-[32rem] w-full max-w-3xl shrink-0 grow flex-col rounded-md border bg-card">
        {editor && (
          <div className="sticky top-0 z-10 rounded-t-md border-b bg-card">
            <Toolbar editor={editor} disabled={disabled} />
          </div>
        )}
        <EditorContent editor={editor} className="flex flex-1 flex-col px-6 py-8 sm:px-12 sm:py-10 [&_.tiptap]:flex-1" />
      </div>
    </div>
  )
}

function Toolbar({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  })
  const chain = () => editor.chain().focus()

  const item = (label: string, Icon: LucideIcon, pressed: boolean, run: () => void) => (
    <Toggle key={label} size="sm" aria-label={label} title={label} pressed={pressed} disabled={disabled} onPressedChange={run}>
      <Icon />
    </Toggle>
  )

  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 px-2 py-1.5">
      {item("Bold", Bold, s.bold, () => chain().toggleBold().run())}
      {item("Italic", Italic, s.italic, () => chain().toggleItalic().run())}
      {item("Underline", UnderlineIcon, s.underline, () => chain().toggleUnderline().run())}
      {item("Strikethrough", Strikethrough, s.strike, () => chain().toggleStrike().run())}
      {item("Inline code", Code, s.code, () => chain().toggleCode().run())}
      <Separator orientation="vertical" className="mx-1 data-vertical:h-5" />
      {item("Heading 1", Heading1, s.h1, () => chain().toggleHeading({ level: 1 }).run())}
      {item("Heading 2", Heading2, s.h2, () => chain().toggleHeading({ level: 2 }).run())}
      {item("Heading 3", Heading3, s.h3, () => chain().toggleHeading({ level: 3 }).run())}
      <Separator orientation="vertical" className="mx-1 data-vertical:h-5" />
      {item("Bulleted list", List, s.bullet, () => chain().toggleBulletList().run())}
      {item("Numbered list", ListOrdered, s.ordered, () => chain().toggleOrderedList().run())}
      {item("Quote", Quote, s.quote, () => chain().toggleBlockquote().run())}
      {item("Code block", Code2, s.codeBlock, () => chain().toggleCodeBlock().run())}
      {item("Divider", Minus, false, () => chain().setHorizontalRule().run())}
      <Separator orientation="vertical" className="mx-1 data-vertical:h-5" />
      <Button size="icon-sm" variant="ghost" aria-label="Undo" title="Undo" disabled={disabled || !s.canUndo} onClick={() => chain().undo().run()}>
        <Undo2 />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Redo" title="Redo" disabled={disabled || !s.canRedo} onClick={() => chain().redo().run()}>
        <Redo2 />
      </Button>
    </div>
  )
}
