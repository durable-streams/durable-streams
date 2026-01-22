import { StrictMode } from "react"
import ReactDOM from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"
import { router } from "./router"

ReactDOM.createRoot(document.getElementById(`root`)!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
