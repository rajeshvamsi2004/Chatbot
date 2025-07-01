// In Aistudio.js
const Pdf = ({ isOpen, onClose, analysisData, userQuery }) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);

  if (!isOpen) return null;

  const handlePrint = () => {
    window.print();
  };

  const handleConfirmDownload = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const { summary, key_points } = analysisData;
      const response = await fetch('http://localhost:5001/generate-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary, key_points, query: userQuery }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => null);
        throw new Error(errData?.error || `PDF generation failed`);
      }
      const { pdfBase64, fileName } = await response.json();
      const byteCharacters = atob(pdfBase64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/pdf' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      onClose();
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    // Add "non-printable" to the overlay as well for extra safety
    <div className="modal-overlay non-printable" onClick={onClose}>
      <div className="modal-content pdf-preview-modal" onClick={e => e.stopPropagation()}>
        <div className="pdf-preview-header">
          <h2>Document Preview</h2>
          <button className="modal-close-button" onClick={onClose} disabled={isGenerating}>
            <CloseIcon />
          </button>
        </div>
        
            <div className="pdf-page printable-area">
              <h3 className="pdf-page-title">Analysis Report: {userQuery}</h3>
              <p className="pdf-page-summary">{analysisData.summary}</p>
              <h4 className="pdf-page-takeaways">Key Takeaways</h4>
              <ul className="pdf-page-list">
                {analysisData.key_points.map((point, index) => <li key={index}>{point}</li>)}
              </ul>
            </div>
       
        {/* THIS IS THE NEW FOOTER FOR THE BUTTONS */}
        <div className="pdf-preview-footer">
            {error && <p className="error-message pdf-error">{error}</p>}
            <button className="button-secondary" onClick={handlePrint} disabled={isGenerating}>
              <PrintIcon /> Print
            </button>
            <button className="button-primary" onClick={handleConfirmDownload} disabled={isGenerating}>
              {isGenerating ? 'Generating...' : <><DownloadIcon /> Download PDF</>}
            </button>
        </div>
      </div>
    </div>
  );
};
export default Pdf;