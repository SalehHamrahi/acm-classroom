import React from 'react';
import MonacoEditor, { loader } from '@monaco-editor/react';

// Monaco's React wrapper is dynamically imported by the application only when
// a code editor is mounted. The actual Monaco runtime is served from /monaco/vs.
loader.config({ paths: { vs: '/monaco/vs' } });

export default function DeferredMonacoEditor(props) {
  return <MonacoEditor {...props} />;
}
