import api from './client'

export interface PatientProfile {
  id: number
  user_id: number
  name: string
  gender: string
  age: string
  phone: string
  residence: string
  diseases: string[]
  symptoms: string[]
  tcm_syndrome: string
  chief_complaint: string
  family_history: Array<{ relation: string; disease: string; onset_age?: string }>
  is_family_member: boolean
  primary_member_id?: number
  is_default: boolean
  constitution?: string
  source_conversation_id?: number
  created_at?: string
  updated_at?: string
}

export const patientAPI = {
  getProfiles: () => api.get<PatientProfile[]>('/api/patient/profiles'),
  createProfile: (data: Partial<PatientProfile> & { user_id: number }) =>
    api.post<PatientProfile>('/api/patient/profiles', data),
  updateProfile: (id: number, data: Partial<PatientProfile>) =>
    api.put<PatientProfile>(`/api/patient/profiles/${id}`, data),
  deleteProfile: (id: number) => api.delete(`/api/patient/profiles/${id}`),
  setDefault: (id: number) =>
    api.post<PatientProfile>(`/api/patient/profiles/${id}/set-default`),
}
