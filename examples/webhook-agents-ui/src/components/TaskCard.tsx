import { useMemo, useState } from "react"
import {
  Badge,
  Box,
  Button,
  Card,
  Code,
  Flex,
  Separator,
  Text,
  TextField,
} from "@radix-ui/themes"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Globe,
  Loader2,
  Search,
  Send,
} from "lucide-react"
import { useLiveQuery } from "@tanstack/react-db"
import { Streamdown } from "streamdown"
import { useTaskDB } from "../lib/use-task-db"
import type { TaskEvent } from "../lib/schema"

interface TaskCardProps {
  taskId: string
  path: string
  description: string
  serverUrl: string | null
}

function isAgentActive(events: Array<TaskEvent>): boolean {
  if (events.length === 0) return false
  const last = events[events.length - 1]
  return (
    last.type === `agent_started` ||
    last.type === `agent_working` ||
    last.type === `llm_text` ||
    last.type === `tool_call`
  )
}

function getStatusBadge(events: Array<TaskEvent>): {
  color: `gray` | `blue` | `amber` | `green` | `red`
  label: string
} {
  if (events.length === 0) return { color: `gray`, label: `Pending` }
  const last = events[events.length - 1]
  switch (last.type) {
    case `assigned`:
      return { color: `gray`, label: `Pending` }
    case `follow_up`:
      return { color: `blue`, label: `Follow-up` }
    case `agent_started`:
      return { color: `blue`, label: `Starting` }
    case `agent_working`:
    case `llm_text`:
    case `tool_call`:
    case `tool_result`:
      return { color: `amber`, label: `Working` }
    case `agent_done`:
      return { color: `green`, label: `Done` }
    case `agent_error`:
      return { color: `red`, label: `Error` }
    default:
      return { color: `gray`, label: `Unknown` }
  }
}

type ContentItem =
  | { kind: `text`; text: string }
  | {
      kind: `tool_call`
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      result?: string
      isError?: boolean
    }

type TimelineSection =
  | {
      kind: `user_message`
      text: string
      timestamp: number
      isInitial: boolean
    }
  | {
      kind: `agent_response`
      items: Array<ContentItem>
      done?: { inputTokens: number; outputTokens: number }
      error?: string
    }

function buildTimeline(events: Array<TaskEvent>): Array<TimelineSection> {
  const sections: Array<TimelineSection> = []
  let currentAgent: Extract<
    TimelineSection,
    { kind: `agent_response` }
  > | null = null

  for (const e of events) {
    if (e.type === `assigned` || e.type === `follow_up`) {
      currentAgent = null
      sections.push({
        kind: `user_message`,
        text: e.task ?? ``,
        timestamp: e.timestamp,
        isInitial: e.type === `assigned`,
      })
      continue
    }

    if (e.type === `agent_started`) {
      currentAgent = { kind: `agent_response`, items: [] }
      sections.push(currentAgent)
      continue
    }

    if (!currentAgent) {
      currentAgent = { kind: `agent_response`, items: [] }
      sections.push(currentAgent)
    }

    switch (e.type) {
      case `llm_text`: {
        if (!e.text) break
        const last = currentAgent.items.at(-1)
        if (last?.kind === `text`) {
          last.text += e.text
        } else {
          currentAgent.items.push({ kind: `text`, text: e.text })
        }
        break
      }
      case `tool_call`:
        currentAgent.items.push({
          kind: `tool_call`,
          toolCallId: e.toolCallId!,
          toolName: e.toolName!,
          args: e.args ?? {},
        })
        break
      case `tool_result`:
        if (e.toolCallId) {
          const tc = currentAgent.items.find(
            (item): item is ContentItem & { kind: `tool_call` } =>
              item.kind === `tool_call` && item.toolCallId === e.toolCallId
          )
          if (tc) {
            tc.result = e.result
            tc.isError = e.isError
          }
        }
        break
      case `agent_done`:
        currentAgent.done = {
          inputTokens: e.inputTokens ?? 0,
          outputTokens: e.outputTokens ?? 0,
        }
        break
      case `agent_error`:
        currentAgent.error = e.error
        break
    }
  }

  return sections
}

export function TaskCard({
  taskId,
  path,
  description,
  serverUrl,
}: TaskCardProps) {
  const streamUrl = serverUrl ? `${serverUrl}${path}` : null
  const db = useTaskDB(streamUrl)

  const { data: events = [] } = useLiveQuery(
    (q: any) => (db ? q.from({ events: db.collections.events as any }) : null),
    [db]
  )

  const sortedEvents = useMemo(
    () =>
      [...events].sort(
        (a, b) => (a as TaskEvent).timestamp - (b as TaskEvent).timestamp
      ) as Array<TaskEvent>,
    [events]
  )

  const active = isAgentActive(sortedEvents)
  const status = getStatusBadge(sortedEvents)
  const timeline = useMemo(() => buildTimeline(sortedEvents), [sortedEvents])

  return (
    <Card size="2">
      <Flex direction="column" gap="3">
        <Flex justify="between" align="center">
          <Flex align="center" gap="2">
            <Text weight="bold" size="3">
              {taskId}
            </Text>
            <Badge color={status.color} variant="soft" size="1">
              {active && <Loader2 size={12} className="animate-spin" />}
              {status.label}
            </Badge>
          </Flex>
        </Flex>

        <Text size="2" color="gray">
          {description}
        </Text>

        {timeline.length > 0 && <Separator size="4" />}

        {timeline.map((section, i) => {
          if (section.kind === `user_message`) {
            return <UserMessage key={i} section={section} />
          }
          const isLast =
            i === timeline.length - 1 ||
            timeline.slice(i + 1).every((s) => s.kind === `user_message`)
          return (
            <AgentResponseView
              key={i}
              section={section}
              isLast={isLast}
              agentActive={active}
            />
          )
        })}

        <FollowUpInput path={path} active={active} />
      </Flex>
    </Card>
  )
}

function UserMessage({
  section,
}: {
  section: Extract<TimelineSection, { kind: `user_message` }>
}) {
  const time = new Date(section.timestamp).toLocaleTimeString()

  return (
    <Box
      py="2"
      px="3"
      style={{
        backgroundColor: `var(--accent-3)`,
        borderRadius: `var(--radius-2)`,
        alignSelf: `flex-end`,
        maxWidth: `85%`,
        marginLeft: `auto`,
      }}
    >
      <Flex align="center" gap="2" mb="1">
        <Text size="1" color="gray">
          {time}
        </Text>
        <Text size="1" weight="bold" color="gray">
          You
        </Text>
      </Flex>
      <Text size="2">{section.text}</Text>
    </Box>
  )
}

function AgentResponseView({
  section,
  isLast,
  agentActive,
}: {
  section: Extract<TimelineSection, { kind: `agent_response` }>
  isLast: boolean
  agentActive: boolean
}) {
  return (
    <Box>
      {section.items.map((item, i) => {
        if (item.kind === `text`) {
          return (
            <Box
              key={i}
              className="markdown-content"
              style={{ fontSize: `var(--font-size-2)`, lineHeight: 1.6 }}
            >
              <Streamdown isAnimating={agentActive}>{item.text}</Streamdown>
            </Box>
          )
        }
        return <ToolCallCard key={item.toolCallId} toolCall={item} />
      })}

      {isLast && agentActive && !section.done && (
        <Flex align="center" gap="1" mt="2">
          <Box
            style={{
              display: `flex`,
              gap: 3,
              alignItems: `center`,
            }}
          >
            <span className="typing-dot" style={{ animationDelay: `0ms` }} />
            <span className="typing-dot" style={{ animationDelay: `150ms` }} />
            <span className="typing-dot" style={{ animationDelay: `300ms` }} />
          </Box>
        </Flex>
      )}

      {section.done && (
        <Flex align="center" gap="2" mt="2">
          <CheckCircle2 size={12} color="var(--green-9)" />
          <Text size="1" color="green">
            Complete
          </Text>
          <Badge color="gray" variant="soft" size="1">
            {section.done.inputTokens + section.done.outputTokens} tokens
          </Badge>
        </Flex>
      )}

      {section.error && (
        <Flex align="center" gap="2" mt="2">
          <AlertCircle size={12} color="var(--red-9)" />
          <Text size="1" color="red">
            {section.error}
          </Text>
        </Flex>
      )}
    </Box>
  )
}

function ToolCallCard({
  toolCall,
}: {
  toolCall: ContentItem & { kind: `tool_call` }
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <Card
      size="1"
      mb="2"
      style={{
        backgroundColor: `var(--gray-2)`,
        cursor: `pointer`,
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <Flex direction="column" gap="1">
        <Flex align="center" gap="2">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {toolCall.toolName === `fetch_url` ? (
            <Globe size={12} color="var(--blue-9)" />
          ) : (
            <Search size={12} color="var(--blue-9)" />
          )}
          <Text size="1" weight="bold">
            {toolCall.toolName}
          </Text>
          {typeof toolCall.args.query === `string` && (
            <Text size="1" color="gray">
              "{toolCall.args.query}"
            </Text>
          )}
          {typeof toolCall.args.url === `string` && (
            <Text size="1" color="gray" truncate>
              {toolCall.args.url}
            </Text>
          )}
          {toolCall.result == null && (
            <Loader2 size={12} className="animate-spin" />
          )}
          {toolCall.isError && (
            <Badge color="red" size="1" variant="soft">
              Error
            </Badge>
          )}
        </Flex>

        {expanded && (
          <Box pl="5">
            <Text size="1" color="gray" mb="1">
              Arguments:
            </Text>
            <Code size="1" style={{ display: `block`, whiteSpace: `pre-wrap` }}>
              {JSON.stringify(toolCall.args, null, 2)}
            </Code>
            {toolCall.result != null && (
              <>
                <Text size="1" color="gray" mt="2" mb="1">
                  Result:
                </Text>
                <Code
                  size="1"
                  style={{
                    display: `block`,
                    whiteSpace: `pre-wrap`,
                    maxHeight: 200,
                    overflow: `auto`,
                  }}
                >
                  {toolCall.result}
                </Code>
              </>
            )}
          </Box>
        )}
      </Flex>
    </Card>
  )
}

function FollowUpInput({ path, active }: { path: string; active: boolean }) {
  const [followUp, setFollowUp] = useState(``)
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    if (!followUp.trim() || sending) return
    setSending(true)
    try {
      await fetch(`/api/server-info`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({
          action: `followup`,
          description: followUp.trim(),
          path,
        }),
      })
      setFollowUp(``)
    } finally {
      setSending(false)
    }
  }

  return (
    <Flex gap="2" mt="1">
      <Box flexGrow="1">
        <TextField.Root
          size="1"
          placeholder={
            active
              ? `Send message (will interrupt agent)...`
              : `Add a follow-up...`
          }
          value={followUp}
          onChange={(e) => setFollowUp(e.target.value)}
          onKeyDown={(e) => e.key === `Enter` && handleSend()}
        />
      </Box>
      <Button
        size="1"
        variant="soft"
        disabled={!followUp.trim() || sending}
        onClick={handleSend}
      >
        <Send size={12} />
      </Button>
    </Flex>
  )
}
