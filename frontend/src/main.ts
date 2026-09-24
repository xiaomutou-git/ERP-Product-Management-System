/**
 * 应用入口（文件级注释）
 * ------------------------------------------------------------------
 * 核心功能：创建 Vue 应用、注册 Pinia/路由/Element Plus（中文语言包与图标）、
 *          引入设计令牌全局样式。
 * 设计思路：Element Plus 全量注册简化开发；设计令牌先于组件样式引入保证覆写生效。
 * 适用场景：index.html 挂载点 #app。
 * 创建时间：2026-09-21
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import '@/styles/tokens.css';
import App from './App.vue';
import router from './router';

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });

app.mount('#app');
