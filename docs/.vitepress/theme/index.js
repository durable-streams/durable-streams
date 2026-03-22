import DefaultTheme, { VPButton } from "vitepress/theme-without-fonts"
import "./custom.css"
import ClientAdapterDiagram from "./components/ClientAdapterDiagram.vue"
import HomeFeatureGrid from "./components/HomeFeatureGrid.vue"
import HostedElectricCard from "./components/HostedElectricCard.vue"
import IntentLink from "./components/IntentLink.vue"
import NavSignupButton from "./components/NavSignupButton.vue"
import ServerConformanceDiagram from "./components/ServerConformanceDiagram.vue"
import YoutubeEmbed from "./components/YoutubeEmbed.vue"
import Layout from "./Layout.vue"

export default {
  enhanceApp({ app }) {
    app.component("ClientAdapterDiagram", ClientAdapterDiagram)
    app.component("HomeFeatureGrid", HomeFeatureGrid)
    app.component("HostedElectricCard", HostedElectricCard)
    app.component("IntentLink", IntentLink)
    app.component("NavSignupButton", NavSignupButton)
    app.component("ServerConformanceDiagram", ServerConformanceDiagram)
    app.component("VPButton", VPButton)
    app.component("YoutubeEmbed", YoutubeEmbed)
  },
  extends: DefaultTheme,
  Layout,
}
