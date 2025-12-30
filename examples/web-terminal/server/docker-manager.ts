import Docker from "dockerode"
import type { Container } from "dockerode"

const docker = new Docker()

interface ContainerInfo {
  container: Container
  containerId: string
  stream: NodeJS.ReadWriteStream | null
  createdAt: Date
  lastActivity: Date
}

const containers = new Map<string, ContainerInfo>()

export async function createContainer(
  sessionId: string,
  image: string = `web-terminal-shell`
): Promise<ContainerInfo> {
  // Check if container already exists for this session
  const existing = containers.get(sessionId)
  if (existing) {
    return existing
  }

  // Pull image if not present
  try {
    await docker.getImage(image).inspect()
  } catch {
    console.log(`Pulling image ${image}...`)
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err)
        docker.modem.followProgress(stream, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    })
  }

  const container = await docker.createContainer({
    Image: image,
    Cmd: [`/bin/bash`],
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Env: [
      `TERM=xterm-256color`,
      `COLORTERM=truecolor`,
      `LANG=en_US.UTF-8`,
      `LC_ALL=en_US.UTF-8`,
      `SHELL=/bin/bash`,
      `DEBIAN_FRONTEND=noninteractive`,
    ],
    Labels: {
      "durable-streams.session": sessionId,
      "durable-streams.app": `web-terminal`,
    },
  })

  await container.start()

  const info: ContainerInfo = {
    container,
    containerId: container.id,
    stream: null,
    createdAt: new Date(),
    lastActivity: new Date(),
  }

  containers.set(sessionId, info)
  return info
}

export async function attachContainer(
  sessionId: string
): Promise<NodeJS.ReadWriteStream> {
  const info = containers.get(sessionId)
  if (!info) {
    throw new Error(`No container found for session ${sessionId}`)
  }

  // Detach existing stream if any
  if (info.stream) {
    info.stream.end()
  }

  // Set initial terminal size
  await resizeContainer(sessionId, 80, 24)

  const stream = await info.container.attach({
    stream: true,
    stdin: true,
    stdout: true,
    stderr: true,
    hijack: true,
  })

  info.stream = stream
  info.lastActivity = new Date()

  return stream
}

export async function resizeContainer(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  const info = containers.get(sessionId)
  if (!info) return

  try {
    await info.container.resize({ h: rows, w: cols })
  } catch (err) {
    // Resize can fail if container isn't fully started
    console.error(`Error resizing container ${sessionId}:`, err)
  }
}

export function updateActivity(sessionId: string): void {
  const info = containers.get(sessionId)
  if (info) {
    info.lastActivity = new Date()
  }
}

export async function stopContainer(sessionId: string): Promise<void> {
  const info = containers.get(sessionId)
  if (!info) return

  if (info.stream) {
    info.stream.end()
    info.stream = null
  }

  try {
    await info.container.stop({ t: 2 })
  } catch (err) {
    // Container might already be stopped
    if (!(err instanceof Error && err.message.includes(`already stopped`))) {
      console.error(`Error stopping container ${sessionId}:`, err)
    }
  }
}

export async function resumeContainer(sessionId: string): Promise<void> {
  const info = containers.get(sessionId)
  if (!info) {
    throw new Error(`No container found for session ${sessionId}`)
  }

  const containerInfo = await info.container.inspect()
  if (!containerInfo.State.Running) {
    await info.container.start()
  }

  info.lastActivity = new Date()
}

export async function deleteContainer(sessionId: string): Promise<void> {
  const info = containers.get(sessionId)
  if (!info) return

  if (info.stream) {
    info.stream.end()
  }

  try {
    await info.container.stop({ t: 2 })
  } catch {
    // Ignore - might already be stopped
  }

  try {
    await info.container.remove({ force: true })
  } catch (err) {
    console.error(`Error removing container ${sessionId}:`, err)
  }

  containers.delete(sessionId)
}

export function getContainer(sessionId: string): ContainerInfo | undefined {
  return containers.get(sessionId)
}

export function listSessions(): Array<{
  sessionId: string
  containerId: string
  createdAt: Date
  lastActivity: Date
}> {
  return Array.from(containers.entries()).map(([sessionId, info]) => ({
    sessionId,
    containerId: info.containerId,
    createdAt: info.createdAt,
    lastActivity: info.lastActivity,
  }))
}

// Restore sessions from running Docker containers on startup
export async function restoreExistingSessions(): Promise<void> {
  const existingContainers = await docker.listContainers({
    all: true,
    filters: {
      label: [`durable-streams.app=web-terminal`],
    },
  })

  for (const containerInfo of existingContainers) {
    const sessionId = containerInfo.Labels[`durable-streams.session`]
    if (sessionId && !containers.has(sessionId)) {
      const container = docker.getContainer(containerInfo.Id)
      containers.set(sessionId, {
        container,
        containerId: containerInfo.Id,
        stream: null,
        createdAt: new Date(containerInfo.Created * 1000),
        lastActivity: new Date(),
      })
      console.log(
        `Restored session ${sessionId} from container ${containerInfo.Id}`
      )
    }
  }
}
