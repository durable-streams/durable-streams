import DefaultTheme, { VPButton } from "vitepress/theme-without-fonts"
import "./custom.css"
import HomeFeatureGrid from "./components/HomeFeatureGrid.vue"
import NavSignupButton from "./components/NavSignupButton.vue"
import Layout from "./Layout.vue"

export default {
  enhanceApp({ app }) {
    app.component("HomeFeatureGrid", HomeFeatureGrid)
    app.component("VPButton", VPButton)
    app.component("NavSignupButton", NavSignupButton)
  },
  extends: DefaultTheme,
  Layout,
}
