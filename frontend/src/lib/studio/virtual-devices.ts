export interface VirtualDeviceStatus {
  supported: boolean;
  platform: string;
  built: boolean;
  signed: boolean;
  packaged: boolean;
  camera: boolean;
  microphone: boolean;
  running: boolean;
  busy: boolean;
  receivingVideo: boolean;
  receivingAudio: boolean;
  activation: string;
  error: string;
}
export interface VirtualDevices {
  status(): Promise<VirtualDeviceStatus>;
  start(): Promise<VirtualDeviceStatus>;
  stop(): Promise<VirtualDeviceStatus>;
  activateCamera(): Promise<VirtualDeviceStatus>;
  installAudio(): Promise<VirtualDeviceStatus>;
}
declare global {
  interface Window {
    lumenVirtualDevices?: VirtualDevices;
    lumenProgramSink?: {
      video(bytes: Uint8Array): Promise<boolean>;
      audio(bytes: Uint8Array): Promise<boolean>;
      fail(message: string): void;
    };
  }
}
