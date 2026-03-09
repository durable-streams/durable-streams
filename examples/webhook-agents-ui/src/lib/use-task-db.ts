import { useEffect, useState } from "react"
import { createStreamDB } from "@durable-streams/state"
import { taskStateSchema } from "./schema"
import type { StreamDB } from "@durable-streams/state"

type TaskDB = StreamDB<typeof taskStateSchema>

/**
 * Hook that creates and manages a StreamDB per task stream URL.
 * Each TaskCard gets its own StreamDB instance that live-syncs
 * from the durable stream, like individual missionaries each
 * maintaining their own area book for their assigned area.
 */
export function useTaskDB(streamUrl: string | null): TaskDB | null {
  const [db, setDB] = useState<TaskDB | null>(null)

  useEffect(() => {
    if (!streamUrl) return

    const taskDB = createStreamDB({
      streamOptions: {
        url: streamUrl,
        contentType: `application/json`,
      },
      state: taskStateSchema,
    })

    taskDB.preload().then(() => setDB(taskDB))

    return () => {
      taskDB.close()
      setDB(null)
    }
  }, [streamUrl])

  return db
}
