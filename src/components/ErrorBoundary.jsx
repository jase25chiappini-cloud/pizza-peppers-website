import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err, info) { console.error('Boundary caught:', err, info); }
  render() {
    return this.state.hasError ? (
      <div style={{padding:'2rem'}}>Something went wrong.</div>
    ) : this.props.children;
  }
}

