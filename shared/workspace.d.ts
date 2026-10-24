/** Public station identity only. An ID names a tenant; it grants no authority. */
export interface StationWorkspace {
  id: string;
  createdAt: string;
  mode: 'local' | 'provisioned';
  configured: boolean;
  message: string;
}
