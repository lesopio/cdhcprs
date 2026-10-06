/** api 模块统一出口 —— 对应 Vue 版的 frontend/src/api/index.ts */
import api from './client'

export default api
export { authAPI } from './auth'
export { chatAPI } from './chat'
export { patientAPI } from './patient'
export { adminAPI } from './admin'
export { API_BASE_URL } from './client'
