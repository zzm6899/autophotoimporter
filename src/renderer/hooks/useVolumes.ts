import { useEffect } from 'react';
import { useAppDispatch } from '../context/ImportContext';

export function useVolumes() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    window.electronAPI.listVolumes().then((volumes) => {
      dispatch({ type: 'SET_VOLUMES', volumes });
    });

    const unsub = window.electronAPI.onVolumesChanged((volumes) => {
      dispatch({ type: 'SET_VOLUMES', volumes });
    });

    return () => { unsub(); };
  }, [dispatch]);
}
