<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme-without-fonts'
import NavSignupButton from './components/NavSignupButton.vue'

const { page } = useData()

const markdownHref = computed(() => {
  const relativePath = page.value?.relativePath || ''
  if (!relativePath) return '/llms.txt'
  return `/${relativePath}`
})
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-content-after>
      <NavSignupButton />
    </template>
    <template #nav-screen-content-after>
      <NavSignupButton :screen-menu="true" />
    </template>
    <template #aside-outline-before>
      <a class="markdown-link-aside pager-link" :href="markdownHref">✨ Markdown</a>
    </template>
  </DefaultTheme.Layout>
</template>
