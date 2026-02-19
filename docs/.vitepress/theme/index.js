import DefaultTheme, { VPButton } from 'vitepress/theme-without-fonts'
import './custom.css'
import NavSignupButton from './components/NavSignupButton.vue'
import Layout from './Layout.vue'

export default {
  enhanceApp({ app }) {
    app.component('VPButton', VPButton)
    app.component('NavSignupButton', NavSignupButton)
  },
  extends: DefaultTheme,
  Layout,
}
