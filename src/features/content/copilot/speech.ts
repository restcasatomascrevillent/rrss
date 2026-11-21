import { useCallback, useEffect, useRef, useState } from 'react';

// Dictado con la Web Speech API del navegador (es-ES). Solo lo que el copiloto
// necesita: empezar, parar, el texto provisional mientras se habla y cada frase
// terminada. El reconocimiento lo hace el navegador (en Chrome, con un servicio
// de Google): está explicado en docs/copiloto-voz.md. Si el navegador no lo
// tiene, `speechRecognitionAvailable()` es falso y el botón no sale.

/** Lo mínimo de `SpeechRecognition` que se usa (la API no está en los tipos de TypeScript). */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechResultEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type SpeechCtor = new () => SpeechRecognitionLike;

function speechCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** ¿Tiene el navegador dictado? */
export function speechRecognitionAvailable(): boolean {
  return speechCtor() !== null;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'El navegador no deja usar el micrófono. Dale permiso en la barra de direcciones y vuelve a probar.',
  'service-not-allowed': 'El navegador no deja usar el dictado en esta página.',
  'audio-capture': 'No se encuentra ningún micrófono.',
  network: 'El dictado del navegador necesita conexión y no la tiene.',
  'language-not-supported': 'El navegador no admite el dictado en español.',
};

export interface Dictation {
  listening: boolean;
  /** Lo que se está diciendo ahora (aún sin terminar). */
  interim: string;
  error: string | null;
  start(): void;
  stop(): void;
}

/**
 * Dictado continuo: llama a `onPhrase` con cada frase terminada. El navegador
 * corta el dictado tras un silencio; mientras la persona no pulse «Parar», se
 * vuelve a empezar solo.
 */
export function useDictation(onPhrase: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const wanted = useRef(false);
  const phrase = useRef(onPhrase);
  useEffect(() => {
    phrase.current = onPhrase;
  }, [onPhrase]);

  const stop = useCallback(() => {
    wanted.current = false;
    setListening(false);
    setInterim('');
    recognition.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = speechCtor();
    if (!Ctor) {
      setError('Este navegador no tiene dictado.');
      return;
    }
    setError(null);
    if (!recognition.current) {
      const r = new Ctor();
      r.lang = 'es-ES';
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (event) => {
        let pending = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i]!;
          const text = result[0].transcript;
          if (result.isFinal) {
            if (text.trim()) phrase.current(text.trim());
          } else {
            pending += text;
          }
        }
        setInterim(pending.trim());
      };
      r.onerror = (event) => {
        // «no-speech» y «aborted» no son errores para la persona: se sigue escuchando.
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        wanted.current = false;
        setListening(false);
        setError(ERRORS[event.error] ?? 'El dictado se ha cortado. Vuelve a pulsar «Dictar».');
      };
      r.onend = () => {
        setInterim('');
        if (wanted.current) {
          try {
            r.start();
          } catch {
            wanted.current = false;
            setListening(false);
          }
        } else {
          setListening(false);
        }
      };
      recognition.current = r;
    }
    wanted.current = true;
    try {
      recognition.current.start();
      setListening(true);
    } catch {
      // Ya estaba escuchando.
      setListening(true);
    }
  }, []);

  useEffect(
    () => () => {
      wanted.current = false;
      recognition.current?.abort();
    },
    [],
  );

  return { listening, interim, error, start, stop };
}
