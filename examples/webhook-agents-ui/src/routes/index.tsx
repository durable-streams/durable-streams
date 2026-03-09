import { createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { Box, Container, Flex, Heading, Text } from "@radix-ui/themes"
import { TaskCard } from "../components/TaskCard"
import { CreateTaskButton } from "../components/CreateTaskButton"

interface TaskInfo {
  id: string
  path: string
  description: string
}

export const Route = createFileRoute(`/`)({
  component: IndexPage,
})

function IndexPage() {
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Array<TaskInfo>>([])

  // Fetch server URL and existing tasks on mount
  useEffect(() => {
    fetch(`/api/server-info`)
      .then((r) => r.json())
      .then((data: { serverUrl: string; tasks: Array<TaskInfo> }) => {
        setServerUrl(data.serverUrl)
        setTasks(data.tasks)
      })
      .catch((err) => console.error(`Failed to fetch server info:`, err))
  }, [])

  const handleTaskCreated = useCallback((task: TaskInfo) => {
    setTasks((prev) => [...prev, task])
  }, [])

  return (
    <Container size="3" py="6">
      <Flex direction="column" gap="5">
        <Flex justify="between" align="center">
          <Box>
            <Heading size="6">Webhook Agents</Heading>
            <Text size="2" color="gray">
              Create tasks and watch agents process them in real-time
            </Text>
          </Box>
          <CreateTaskButton onCreated={handleTaskCreated} />
        </Flex>

        {tasks.length === 0 && (
          <Flex
            direction="column"
            align="center"
            gap="2"
            py="9"
            style={{ opacity: 0.5 }}
          >
            <Text size="3">No tasks yet</Text>
            <Text size="2" color="gray">
              Click "Create Task" to get started
            </Text>
          </Flex>
        )}

        <Flex direction="column" gap="3">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              taskId={task.id}
              path={task.path}
              description={task.description}
              serverUrl={serverUrl}
            />
          ))}
        </Flex>
      </Flex>
    </Container>
  )
}
