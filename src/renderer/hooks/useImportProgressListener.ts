import { useEffect } from 'react';
import { useAppDispatch } from '../context/ImportContext';

export function useImportProgressListener() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const unsub = window.electronAPI.onImportProgress((progress) => {
      dispatch({ type: 'IMPORT_PROGRESS', progress });
    });
    return () => {
      unsub();
    };
  }, [dispatch]);
}
