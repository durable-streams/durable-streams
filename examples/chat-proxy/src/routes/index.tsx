import { createFileRoute } from "@tanstack/react-router"
import { DurableChat } from "../components/DurableChat"

const proxyUrl =
  import.meta.env.VITE_PROXY_URL || `http://localhost:4000/v1/proxy/chat`
const apiUrl = import.meta.env.VITE_API_URL || `http://localhost:4002/api/chat`

export const Route = createFileRoute(`/`)({
  component: () => <DurableChat proxyUrl={proxyUrl} apiUrl={apiUrl} />,
})
