<script setup>
import DefaultTheme from 'vitepress/theme-without-fonts'
import NavSignupButton from './components/NavSignupButton.vue'
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-content-after>
      <NavSignupButton />
    </template>
    <template #nav-screen-content-after>
      <NavSignupButton :screen-menu="true" />
    </template>
  </DefaultTheme.Layout>
</template>
