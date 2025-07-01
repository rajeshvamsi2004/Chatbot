// Add this new component to Aistudio.jsx

const LoadingOverlay = ({ messages }) => {
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);

  useEffect(() => {
    // This effect runs when the component mounts (i.e., when isLoading becomes true)
    const interval = setInterval(() => {
      setCurrentMessageIndex(prevIndex => {
        // Loop back to the start if we've shown all messages
        const nextIndex = prevIndex + 1;
        return nextIndex >= messages.length ? prevIndex : nextIndex; // Stop at the last message
      });
    }, 1800); // Change message every 1.8 seconds

    // This is the cleanup function. It runs when the component unmounts.
    return () => clearInterval(interval);
  }, [messages.length]); // Re-run effect if the list of messages changes

  return (
    <div className="loading-overlay">
      <div className="loading-popup">
        <div className="loading-spinner"></div>
        <p className="loading-message">{messages[currentMessageIndex]}</p>
      </div>
    </div>
  );
};