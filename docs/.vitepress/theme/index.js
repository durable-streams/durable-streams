import DefaultTheme, { VPButton } from "vitepress/theme-without-fonts"
import "./custom.css"
import ClientAdapterDiagram from "./components/ClientAdapterDiagram.vue"
import HomeFeatureGrid from "./components/HomeFeatureGrid.vue"
import HostedElectricCard from "./components/HostedElectricCard.vue"
import NavSignupButton from "./components/NavSignupButton.vue"
import ServerConformanceDiagram from "./components/ServerConformanceDiagram.vue"
import Layout from "./Layout.vue"

export default {
  enhanceApp({ app }) {
    app.component("ClientAdapterDiagram", ClientAdapterDiagram)
    app.component("HomeFeatureGrid", HomeFeatureGrid)
    app.component("HostedElectricCard", HostedElectricCard)
    app.component("VPButton", VPButton)
    app.component("NavSignupButton", NavSignupButton)
    app.component("ServerConformanceDiagram", ServerConformanceDiagram)
  },
  extends: DefaultTheme,
  Layout,
}
