// Datos de un archivo de medios según ffprobe.
import { PermanentError } from '../errors.ts';
import { ProcessError, runProcess, type MediaTools } from './run.ts';

export interface VideoStreamInfo {
  codec: string;
  /** Tamaño tal como se ve (ya girado si el archivo trae rotación). */
  width: number;
  height: number;
  /** Tamaño tal como está guardado, sin aplicar ninguna rotación. */
  codedWidth: number;
  codedHeight: number;
  fps: number;
  pixelFormat: string;
}

export interface AudioStreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface MediaInfo {
  formatName: string;
  durationSeconds: number;
  sizeBytes: number;
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number | string }>;
  disposition?: { attached_pic?: number };
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { format_name?: string; duration?: string; size?: string };
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !Number.isFinite(n)) return 0;
  return d ? n / d : n;
}

export async function probeMedia(tools: MediaTools, file: string, signal?: AbortSignal): Promise<MediaInfo> {
  let raw: string;
  try {
    raw = await runProcess(
      tools.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { signal },
    );
  } catch (error) {
    if (error instanceof ProcessError && !error.message.startsWith('No se pudo ejecutar')) {
      throw new PermanentError(`El archivo no es un medio legible: ${error.message}`);
    }
    throw error;
  }
  const data = JSON.parse(raw) as ProbeOutput;
  const streams = data.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  let video: VideoStreamInfo | undefined;
  if (videoStream?.width && videoStream.height) {
    const rotation = Number(
      videoStream.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? videoStream.tags?.rotate ?? 0,
    );
    const sideways = Math.abs(rotation) % 180 === 90;
    video = {
      codec: videoStream.codec_name ?? '',
      width: sideways ? videoStream.height : videoStream.width,
      height: sideways ? videoStream.width : videoStream.height,
      codedWidth: videoStream.width,
      codedHeight: videoStream.height,
      fps: parseRate(videoStream.avg_frame_rate) || parseRate(videoStream.r_frame_rate),
      pixelFormat: videoStream.pix_fmt ?? '',
    };
  }
  const audio: AudioStreamInfo | undefined = audioStream
    ? {
        codec: audioStream.codec_name ?? '',
        sampleRate: Number(audioStream.sample_rate ?? 0),
        channels: audioStream.channels ?? 0,
      }
    : undefined;

  return {
    formatName: data.format?.format_name ?? '',
    durationSeconds: Number(data.format?.duration ?? 0) || 0,
    sizeBytes: Number(data.format?.size ?? 0) || 0,
    video,
    audio,
  };
}
