import type { LucideIcon } from "lucide-react"
import { PageTop } from "@/components/page-header"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

interface Props {
  title: string
  description: string
  icon: LucideIcon
}

/** Honest empty state for sections that are not built yet. */
export function ComingSoonPage({ title, description, icon: Icon }: Props) {
  return (
    <>
      <PageTop />
      <div className="flex flex-1 p-6">
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon />
            </EmptyMedia>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </>
  )
}
