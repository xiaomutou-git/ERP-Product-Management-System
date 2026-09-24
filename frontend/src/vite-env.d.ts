/// <reference types="vite/client" />

/**
 * Vue 单文件组件模块声明（供 TypeScript 识别 .vue 导入）
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<Record<string, never>, Record<string, never>, any>;
  export default component;
}
