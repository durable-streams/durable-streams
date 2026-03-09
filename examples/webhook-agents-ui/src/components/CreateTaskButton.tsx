import { useState } from "react"
import { Button, Dialog, Flex, TextField } from "@radix-ui/themes"
import { Plus } from "lucide-react"

interface TaskInfo {
  id: string
  path: string
  description: string
}

const PRESETS = [
  `What are the latest developments in WebAssembly?`,
  `Explain the CAP theorem`,
  `Write a haiku about durable streams`,
  `What's trending on Hacker News today?`,
]

interface CreateTaskButtonProps {
  onCreated: (task: TaskInfo) => void
}

export function CreateTaskButton({ onCreated }: CreateTaskButtonProps) {
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState(``)
  const [creating, setCreating] = useState(false)

  const handleCreate = async (desc: string) => {
    if (!desc.trim() || creating) return
    setCreating(true)
    try {
      const res = await fetch(`/api/server-info`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ action: `create`, description: desc.trim() }),
      })
      const data = (await res.json()) as { taskId: string; path: string }
      onCreated({ id: data.taskId, path: data.path, description: desc.trim() })
      setDescription(``)
      setOpen(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <Button>
          <Plus size={16} />
          Create Task
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="450px">
        <Dialog.Title>Create Task</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          Enter a task description or pick a preset.
        </Dialog.Description>

        <Flex direction="column" gap="3" mt="4">
          <TextField.Root
            placeholder="Describe the task..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === `Enter` && handleCreate(description)}
          />

          <Flex gap="2" wrap="wrap">
            {PRESETS.map((preset) => (
              <Button
                key={preset}
                size="1"
                variant="soft"
                color="gray"
                onClick={() => handleCreate(preset)}
                disabled={creating}
              >
                {preset}
              </Button>
            ))}
          </Flex>
        </Flex>

        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Cancel
            </Button>
          </Dialog.Close>
          <Button
            onClick={() => handleCreate(description)}
            disabled={!description.trim() || creating}
          >
            {creating ? `Creating...` : `Create`}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  )
}
