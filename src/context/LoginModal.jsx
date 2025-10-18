import React from 'react';
import { useAuth } from '../context/AuthContext';

// Simple SVG icon for Google
const GoogleIcon = () => (
    <svg viewBox="0 0 24 24" width="24" height="24" style={{ marginRight: '1rem' }}>
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
);

function LoginModal({ onClose }) {
    const { loginWithGoogle } = useAuth();

    const handleGoogleLogin = async () => {
        try {
            await loginWithGoogle();
            onClose(); // Close the modal on successful login
        } catch (error) {
            console.error("Failed to log in with Google", error);
            // You could show an error message to the user here
        }
    };

    const buttonStyle = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        padding: '0.75rem',
        marginBottom: '1rem',
        borderRadius: '0.5rem',
        border: '1px solid var(--border-color)',
        backgroundColor: 'var(--background-dark)',
        color: 'var(--text-light)',
        fontSize: '1rem',
        fontFamily: 'var(--font-heading)',
        cursor: 'pointer',
        transition: 'background-color 0.2s',
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{maxWidth: '400px'}}>
                <div className="modal-header">
                    <h3 className="panel-title">Login or Sign Up</h3>
                    <button onClick={onClose} className="quantity-btn" style={{width: '2.5rem', height: '2.5rem'}}>&times;</button>
                </div>
                <div className="modal-body">
                    <button style={buttonStyle} onClick={handleGoogleLogin}>
                        <GoogleIcon />
                        Continue with Google
                    </button>
                    {/* We will add Apple and Phone buttons here in a later step */}
                    <p style={{textAlign: 'center', color: 'var(--text-medium)', fontSize: '0.8rem'}}>
                        By continuing, you agree to our Terms and Conditions.
                    </p>
                </div>
            </div>
        </div>
    );
}

export default LoginModal;
