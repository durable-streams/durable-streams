import DefaultTheme, { VPButton } from 'vitepress/theme-without-fonts'
import './custom.css'
import HomeLanding from './components/HomeLanding.vue'
import NavSignupButton from './components/NavSignupButton.vue'
import Layout from './Layout.vue'

export default {
  enhanceApp({ app }) {
    app.component('HomeLanding', HomeLanding)
    app.component('VPButton', VPButton)
    app.component('NavSignupButton', NavSignupButton)
  },
  extends: DefaultTheme,
  Layout,
}
